type JsonRecord = Record<string, any>;

export interface TrueForgeHarnessClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface TrueForgeInlineAgentSpec {
  model: { name: string; [key: string]: unknown };
  instructions: string;
  mcp_servers?: Array<{
    name: string;
    enable_tools?: string[];
    disable_tools?: string[];
    require_approval_for_tools?: string[];
    preload?: boolean;
  }>;
  config?: JsonRecord;
  [key: string]: unknown;
}

export interface TrueForgeTurnResult {
  sessionId: string;
  turnId?: string;
  status: string;
  answer: string;
  metrics?: JsonRecord;
  events: JsonRecord[];
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => {
    if (typeof block === 'string') return block;
    if (typeof block?.text === 'string') return block.text;
    if (typeof block?.content === 'string') return block.content;
    return '';
  }).filter(Boolean).join('\n');
}

function timeoutSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1_000, timeoutMs));
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

export class TrueForgeHarnessClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TrueForgeHarnessClientOptions = {}) {
    this.baseUrl = trimSlash(options.baseUrl ?? 'http://127.0.0.1:8790');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(accept = 'application/json'): Record<string, string> {
    return {
      accept,
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async health(signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(this.url('/healthz'), {
      headers: this.headers(),
      signal: timeoutSignal(Math.min(this.timeoutMs, 15_000), signal),
    });
    if (!response.ok) throw new Error(`TrueForge health check failed: HTTP ${response.status}`);
  }

  async createSession(spec: TrueForgeInlineAgentSpec, signal?: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(this.url('/api/v1/sessions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ agent: { spec } }),
      signal: timeoutSignal(this.timeoutMs, signal),
    });
    const body: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`TrueForge session create failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 1_500)}`);
    }
    const sessionId = body?.data?.id;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('TrueForge session response did not contain data.id');
    return sessionId;
  }

  async cancelSession(sessionId: string): Promise<void> {
    const response = await this.fetchImpl(this.url(`/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({}),
      signal: timeoutSignal(Math.min(this.timeoutMs, 15_000)),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`TrueForge session cancel failed: HTTP ${response.status}`);
    }
  }

  private async pollTerminalTurn(
    sessionId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<{ turnId?: string; status: string; answer: string; metrics?: JsonRecord }> {
    const deadline = Date.now() + timeoutMs;
    let turnId: string | undefined;

    while (Date.now() < deadline) {
      if (signal.aborted) throw signal.reason ?? new Error('TrueForge turn aborted');
      if (!turnId) {
        const listResponse = await this.fetchImpl(this.url(`/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`), {
          headers: this.headers(),
          signal: timeoutSignal(Math.min(15_000, Math.max(1_000, deadline - Date.now())), signal),
        });
        const listBody: any = await listResponse.json().catch(() => ({}));
        const turns = Array.isArray(listBody?.data) ? listBody.data : [];
        const candidate = turns[0]?.id;
        if (typeof candidate === 'string' && candidate) turnId = candidate;
      }

      if (turnId) {
        const response = await this.fetchImpl(
          this.url(`/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`),
          {
            headers: this.headers(),
            signal: timeoutSignal(Math.min(15_000, Math.max(1_000, deadline - Date.now())), signal),
          },
        );
        const body: any = await response.json().catch(() => ({}));
        const state = body?.data?.state ?? {};
        const status = typeof state?.status === 'string' ? state.status : 'running';
        if (['done', 'error', 'cancelled'].includes(status)) {
          const output = state?.output;
          return {
            turnId,
            status,
            answer: textFromContent(output?.content ?? output),
            metrics: state?.metrics,
          };
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`TrueForge turn did not finish within ${timeoutMs}ms`);
  }

  async runTurn(
    sessionId: string,
    prompt: string,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      onEvent?: (event: JsonRecord) => void | Promise<void>;
    } = {},
  ): Promise<TrueForgeTurnResult> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const requestSignal = timeoutSignal(timeoutMs, signal);
    let response: Response;

    try {
      response = await this.fetchImpl(this.url(`/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`), {
        method: 'POST',
        headers: this.headers('text/event-stream'),
        body: JSON.stringify({
          input: [{ type: 'user.message', content: prompt }],
          previous_turn_id: 'none',
          stream: true,
        }),
        signal: requestSignal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        await this.cancelSession(sessionId).catch(() => undefined);
      }
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`TrueForge turn start failed: HTTP ${response.status} ${body.slice(0, 1_500)}`);
    }
    if (!response.body) throw new Error('TrueForge turn response did not include an SSE body');

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    const events: JsonRecord[] = [];
    let buffer = '';
    let lastMessage = '';
    let terminal: TrueForgeTurnResult | undefined;
    let observedTurnId: string | undefined;

    const handleEvent = async (event: JsonRecord) => {
      events.push(event);
      await options.onEvent?.(event);
      if (event.type === 'turn.created' && typeof event?.turn?.id === 'string') observedTurnId = event.turn.id;
      if (event.type === 'model.message') {
        const text = textFromContent(event.content);
        if (text.trim()) lastMessage = text;
      }
      if (event.type === 'turn.done') {
        const state = event.state ?? {};
        terminal = {
          sessionId,
          turnId: typeof event?.turn_id === 'string' ? event.turn_id : observedTurnId,
          status: typeof state?.status === 'string' ? state.status : 'done',
          answer: textFromContent(state?.output?.content ?? state?.output) || lastMessage,
          metrics: state?.metrics,
          events,
        };
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          try {
            const event = JSON.parse(trimmed.slice(5).trim());
            await handleEvent(event);
          } catch {
            // Ignore malformed/non-JSON SSE data and continue consuming the stream.
          }
        }
        if (terminal) return terminal;
        if (done) break;
      }
    } catch (error) {
      if (options.signal?.aborted) {
        await this.cancelSession(sessionId).catch(() => undefined);
        throw options.signal.reason ?? error;
      }
      if (!(error instanceof DOMException && error.name === 'TimeoutError')) throw error;
    } finally {
      reader.releaseLock();
    }

    const polled = await this.pollTerminalTurn(sessionId, requestSignal, Math.max(1_000, timeoutMs));
    return {
      sessionId,
      turnId: polled.turnId ?? observedTurnId,
      status: polled.status,
      answer: polled.answer || lastMessage,
      metrics: polled.metrics,
      events,
    };
  }
}

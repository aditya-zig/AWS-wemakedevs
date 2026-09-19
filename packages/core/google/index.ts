import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  stateSecret: string;
  stateTtlMs?: number;
}

export interface GoogleUser {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  emailVerified?: boolean;
}

export interface GoogleOAuthTransport {
  exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    code: string;
  }): Promise<{ access_token?: string; error?: string; error_description?: string }>;
  fetchUser(accessToken: string): Promise<{
    sub?: string;
    email?: string;
    name?: string | null;
    picture?: string | null;
    email_verified?: boolean;
  }>;
}

interface PendingState {
  state: string;
  expiresAt: number;
}

export class GoogleOAuthService {
  readonly #pendingStates = new Map<string, PendingState>();
  readonly #users = new Map<string, GoogleUser>();

  constructor(
    private readonly config: GoogleOAuthConfig,
    private readonly transport: GoogleOAuthTransport,
  ) {}

  createAuthorizationUrl(sessionId: string): { authorizationUrl: string; state: string } {
    const issuedAt = Date.now();
    const nonce = randomUUID();
    const payload = `google.${sessionId}.${issuedAt}.${nonce}`;
    const signature = createHmac('sha256', this.config.stateSecret).update(payload).digest('base64url');
    const state = Buffer.from(`${payload}.${signature}`).toString('base64url');
    const ttl = this.config.stateTtlMs ?? 10 * 60_000;
    this.#pendingStates.set(sessionId, { state, expiresAt: issuedAt + ttl });

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      include_granted_scopes: 'true',
    });
    return {
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
      state,
    };
  }

  private verifyAndConsumeState(sessionId: string, encodedState: string): void {
    const pending = this.#pendingStates.get(sessionId);
    this.#pendingStates.delete(sessionId);
    if (!pending) throw new Error('Invalid or expired OAuth state');
    if (Date.now() > pending.expiresAt) throw new Error('OAuth state expired');

    const expectedState = Buffer.from(pending.state);
    const actualState = Buffer.from(encodedState);
    if (actualState.length !== expectedState.length || !timingSafeEqual(actualState, expectedState)) {
      throw new Error('Invalid OAuth state');
    }

    let decoded = '';
    try {
      decoded = Buffer.from(encodedState, 'base64url').toString('utf8');
    } catch {
      throw new Error('Invalid OAuth state');
    }
    const parts = decoded.split('.');
    if (parts.length !== 5) throw new Error('Invalid OAuth state');
    const [provider, storedSession, issuedAtText, nonce, signature] = parts;
    if (provider !== 'google' || storedSession !== sessionId || !nonce) throw new Error('OAuth state session mismatch');
    const issuedAt = Number(issuedAtText);
    if (!Number.isFinite(issuedAt) || Math.abs(Date.now() - issuedAt) > (this.config.stateTtlMs ?? 10 * 60_000)) {
      throw new Error('OAuth state expired');
    }
    const payload = `${provider}.${storedSession}.${issuedAt}.${nonce}`;
    const expectedSignature = createHmac('sha256', this.config.stateSecret).update(payload).digest();
    let actualSignature: any;
    try {
      actualSignature = Buffer.from(signature, 'base64url');
    } catch {
      throw new Error('Invalid OAuth state signature');
    }
    if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new Error('Invalid OAuth state signature');
    }
  }

  isAuthenticated(sessionId: string): boolean {
    return this.#users.has(sessionId);
  }

  getAuthenticatedUser(sessionId: string): GoogleUser {
    const user = this.#users.get(sessionId);
    if (!user) throw new Error('Google session is not authenticated');
    return { ...user };
  }

  logout(sessionId: string): void {
    this.#pendingStates.delete(sessionId);
    this.#users.delete(sessionId);
  }

  async handleCallback(sessionId: string, code: string, state: string): Promise<void> {
    this.verifyAndConsumeState(sessionId, state);
    const token = await this.transport.exchangeCode({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      callbackUrl: this.config.callbackUrl,
      code,
    });
    if (!token.access_token) {
      const detail = token.error_description || token.error;
      throw new Error(`Google OAuth failed${detail ? `: ${detail}` : ''}`);
    }

    const profile = await this.transport.fetchUser(token.access_token);
    if (!profile.sub || !profile.email) throw new Error('Google OAuth user profile is missing sub or email');
    this.#users.set(sessionId, {
      id: profile.sub,
      email: profile.email,
      ...(profile.name ? { name: profile.name } : {}),
      ...(profile.picture ? { avatarUrl: profile.picture } : {}),
      ...(typeof profile.email_verified === 'boolean' ? { emailVerified: profile.email_verified } : {}),
    });
  }
}

export class FetchGoogleOAuthTransport implements GoogleOAuthTransport {
  async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    code: string;
  }): Promise<{ access_token?: string; error?: string; error_description?: string }> {
    const body = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      grant_type: 'authorization_code',
      redirect_uri: input.callbackUrl,
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const payload = await response.json() as any;
    if (!response.ok) {
      throw new Error(`Google token exchange failed (${response.status}): ${payload?.error_description || payload?.error || 'unknown error'}`);
    }
    return payload;
  }

  async fetchUser(accessToken: string): Promise<{
    sub?: string;
    email?: string;
    name?: string | null;
    picture?: string | null;
    email_verified?: boolean;
  }> {
    const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
    });
    const payload = await response.json() as any;
    if (!response.ok) {
      throw new Error(`Google userinfo request failed (${response.status}): ${payload?.error_description || payload?.error || 'unknown error'}`);
    }
    return payload;
  }
}

export class AdapterRuntime {
  constructor() { this.adapters = new Map(); }

  register(adapter) {
    if (!adapter?.name || typeof adapter.execute !== 'function') throw new Error('invalid adapter');
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  names() { return [...this.adapters.keys()].sort(); }

  async execute(name, experiment, context = {}) {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`adapter ${name} not registered`);
    const health = await adapter.healthcheck();
    if (!health?.ok) return { status: 'unknown', observations: [health?.detail ?? 'adapter unhealthy'], evidence: [] };
    await adapter.prepare(context);
    try {
      const output = await adapter.execute(experiment);
      const status = ['pass', 'fail', 'unknown'].includes(output?.status) ? output.status : 'unknown';
      const evidence = (output?.evidence ?? []).map((item) => ({
        kind: item.kind ?? 'runtime',
        source: item.source ?? adapter.name,
        executed: item.executed === true,
        payload: item.payload ?? {}
      }));
      return { status, observations: output?.observations ?? [], evidence };
    } catch (error) {
      return {
        status: 'unknown',
        observations: [`${adapter.name} execution error: ${error instanceof Error ? error.message : String(error)}`],
        evidence: [{ kind: 'runtime', source: adapter.name, executed: true, payload: { error: String(error) } }]
      };
    } finally {
      await adapter.stop();
    }
  }
}

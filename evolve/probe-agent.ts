/**
 * The half of the generic-flow probe that runs the code under test: the candidate's
 * BrowserService, in its own process. evolve/probe-generic-flow.ts asks over IPC and
 * judges the answers; nothing here prints a check, so nothing the candidate patches in
 * this process (process.stdout, process.exit) can change what the probe reports.
 */
import { BrowserService } from '../src/browser/service.js';

const service = new BrowserService({
  policy: {
    autoApprove: true,
    adSkipIntervalMs: 0,
    approve: async () => true,
    // The fixture server is on 127.0.0.1 and the browser refuses private addresses by
    // default, which is the right default and useless here.
    allowPrivateHosts: true,
  },
  timeoutMs: 20_000,
});

const METHODS = new Set(['open', 'snapshot', 'execJs', 'screenshot', 'closeAll']);
type Ask = { id: number; method: string; args: unknown[] };

process.on('message', async (m: Ask) => {
  let reply: { id: number; ok: boolean; value?: unknown; error?: string };
  try {
    if (!METHODS.has(m.method)) throw new Error(`método desconocido: ${m.method}`);
    const fn = (service as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
      m.method
    ];
    if (typeof fn !== 'function') throw new Error(`método desconocido: ${m.method}`);
    reply = { id: m.id, ok: true, value: await fn.apply(service, m.args) };
  } catch (err) {
    reply = { id: m.id, ok: false, error: String((err as Error)?.message ?? err) };
  }
  process.send?.(reply);
});
process.on('disconnect', () => process.exit(0));
process.send?.({ ready: true });

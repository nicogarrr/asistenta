import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { describeBrowser } from './helpers/real-browser.js';

/**
 * Compra de punta a punta contra la tienda sintética de qa/shop-harness (local, sin
 * pagos reales: /pay solo cuenta golpes). Modelo guionizado, Gate del daemon
 * (`allowUntilPayment`), agente, herramienta `browser` y Chromium reales. El flujo
 * tiene que llegar solo hasta la aprobación del pago y no pagar sin un «sí».
 */
const root = mkdtempSync(join(tmpdir(), 'pa-e2e-checkout-'));
process.env.PA_STATE_DIR = join(root, 'state');
process.env.PA_VAULT_BACKEND = 'portable';
process.env.PA_SECRET_PROVIDER_APIKEY = 'test-key-never-used';
process.env.PA_API_KEY = 'test-key-never-used';

vi.mock('../src/core/provider.js', () => ({
  createProviderHandle: async () =>
    (globalThis as unknown as { __e2eProvider?: { handle: unknown } }).__e2eProvider?.handle,
}));
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { Core, ScriptedModel, call, say } = await import('./helpers/e2e-core.js');
const { BrowserService } = await import('../src/browser/service.js');
const { createBrowserTool } = await import('../src/tools/browser.js');

interface ShopState {
  cart: unknown[];
  payHits: number;
}
const shop = (await import('../qa/shop-harness/shop.mjs' as string)) as {
  start: (p: number) => Promise<{ close: () => void; address: () => AddressInfo | string | null }>;
  state: ShopState;
};
// Puerto libre que da el sistema (start(0)): un puerto fijo o al azar choca con otra suite
// que corre a la vez en la misma máquina y el beforeAll se colgaba hasta los 60 s.
let BASE = '';

let srv: { close: () => void };
let svc: InstanceType<typeof BrowserService>;
beforeAll(async () => {
  const listening = await shop.start(0);
  srv = listening;
  BASE = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
  svc = new BrowserService({
    policy: { allowPrivateHosts: true, autoApprove: true, approve: async () => true },
    channel: 'chromium',
    timeoutMs: 15_000,
  });
}, 60_000);

let seq = 0;
const cores: InstanceType<typeof Core>[] = [];
function boot(): InstanceType<typeof Core> {
  shop.state.cart.length = 0;
  shop.state.payHits = 0;
  const core = new Core(join(root, `s${++seq}`)).start();
  core.extraTools = [createBrowserTool(svc, () => `shop-${seq}`) as unknown as AgentTool];
  cores.push(core);
  return core;
}

afterEach(() => {
  for (const c of cores.splice(0)) {
    try {
      c.stop();
    } catch {
      /* ya parado */
    }
  }
});
afterAll(async () => {
  await svc.closeAll();
  srv.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const toPayment = () => [
  call('browser', { action: 'open', url: `${BASE}/p/p1` }),
  call('browser', { action: 'click', selector: '#add' }),
  call('browser', { action: 'open', url: `${BASE}/checkout` }),
  call('browser', { action: 'click', selector: '#pay' }),
];

/** La pregunta del botón de pago de la tienda: «Pagar 7,50 €». */
const isPayQuestion = (q: string): boolean => /Pagar \d/.test(q);

describeBrowser('compra en la tienda sintética de punta a punta', () => {
  it('con «sí» a la cesta, se para en «Pagar» con el importe y sin «sí» no paga', async () => {
    const core = boot();
    // La cesta y la página de pago son vocabulario de dinero: preguntan (más estricto
    // de lo que promete allowUntilPayment). Nico dice «sí» a todo menos al pago.
    core.telegram.answers.push(true, true, false);
    const model = new ScriptedModel();
    model.script(...toPayment(), say('Te dejo la cesta lista; el pago lo confirmas tú.'));
    const t = await core.thread();
    const r = await t.user('pídeme una margarita');
    expect(r.error).toBeNull();
    expect(shop.state.cart).toHaveLength(1);
    const last = core.telegram.approvals.at(-1);
    expect(last?.approved).toBe(false);
    expect(isPayQuestion(last?.question ?? '')).toBe(true);
    expect(last?.question).toContain('7,50');
    expect(shop.state.payHits).toBe(0);
  }, 60_000);

  it('sin ningún «sí» no llega ni a la cesta ni al pago', async () => {
    const core = boot();
    const model = new ScriptedModel();
    model.script(...toPayment(), say('Necesito tu permiso.'));
    const t = await core.thread();
    await t.user('pídeme una margarita');
    expect(shop.state.cart).toHaveLength(0);
    expect(shop.state.payHits).toBe(0);
    expect(core.telegram.approvals.every((a) => !a.approved)).toBe(true);
  }, 60_000);

  it('un «Siempre» en el pago no se guarda: el siguiente pago vuelve a preguntar', async () => {
    const core = boot();
    core.telegram.answers.push(true, true, { approved: true, scope: 'always' });
    const model = new ScriptedModel();
    model.script(
      ...toPayment(),
      say('Pagado.'),
      call('browser', { action: 'open', url: `${BASE}/checkout` }),
      call('browser', { action: 'click', selector: '#pay' }),
      say('No me dejaste pagar otra vez.'),
    );
    const t = await core.thread();
    await t.user('pídeme una margarita y págala');
    expect(shop.state.payHits).toBe(1);
    const before = core.telegram.approvals.length;
    core.telegram.answers.push(true, false);
    await t.user('vuelve a pagar lo mismo');
    const turn2 = core.telegram.approvals.slice(before);
    expect(turn2.filter((a) => isPayQuestion(a.question))).toEqual([
      expect.objectContaining({ approved: false }),
    ]);
    expect(shop.state.payHits).toBe(1);
  }, 60_000);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { describeBrowser } from './helpers/real-browser.js';

/**
 * «Siempre» por acción (#425) de punta a punta: modelo guionizado, Gate del daemon,
 * agente, herramienta `browser` y Chromium reales contra una página local con un
 * botón «Enviar» y otro «Borrar mensajes». Un «Siempre» en «Enviar» vale para ese
 * botón y nada más: ni para «Borrar mensajes», ni para otro chat, ni para un «Enviar»
 * que ha cambiado de texto. Y sobrevive a reiniciar el daemon.
 */
const root = mkdtempSync(join(tmpdir(), 'pa-e2e-siempre-'));
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

/** Lo que de verdad llegó al servidor: cada botón pulsado deja una marca. */
const hits: string[] = [];
// Ids neutros: un id «send» ya es vocabulario de dinero («send money») y entonces
// ningún «Siempre» se guarda (lo fija el último escenario).
const page = (label: string, h1: string): string =>
  `<!doctype html><title>Soporte</title><h1>${h1}</h1>
<button id="b1" onclick="fetch('/hit?b=send')">${label}</button>
<button id="b2" onclick="fetch('/hit?b=del')">Borrar mensajes</button>`;
let srv: Server;
let BASE = '';
let svc: InstanceType<typeof BrowserService>;
beforeAll(async () => {
  srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/hit') {
      hits.push(u.searchParams.get('b') ?? '?');
      res.end('{}');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      page(
        u.searchParams.get('label') ?? 'Enviar',
        u.searchParams.get('h1') ?? 'Escribir a soporte',
      ),
    );
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  svc = new BrowserService({
    policy: { allowPrivateHosts: true, autoApprove: true, approve: async () => true },
    channel: 'chromium',
    timeoutMs: 15_000,
  });
}, 60_000);

const cores: InstanceType<typeof Core>[] = [];
/** Un daemon sobre `dir`: reutilizar el mismo dir es reiniciar con el mismo estado. */
function boot(dir: string): InstanceType<typeof Core> {
  const core = new Core(join(root, dir)).start();
  core.extraTools = [createBrowserTool(svc, () => `siempre-${dir}`) as unknown as AgentTool];
  cores.push(core);
  return core;
}
function stopAll(): void {
  for (const c of cores.splice(0)) {
    try {
      c.stop();
    } catch {
      /* ya parado */
    }
  }
}
afterEach(() => {
  stopAll();
  hits.length = 0;
});
afterAll(async () => {
  await svc.closeAll();
  srv.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));
const clickOn = (selector: string, label = 'Enviar', h1 = 'Escribir a soporte') => [
  call('browser', {
    action: 'open',
    url: `${BASE}/?label=${encodeURIComponent(label)}&h1=${encodeURIComponent(h1)}`,
  }),
  call('browser', { action: 'click', selector }),
];

describeBrowser('«Siempre» por acción de punta a punta', () => {
  it('«Siempre» en «Enviar»: el siguiente «Enviar» no pregunta, «Borrar mensajes» sí', async () => {
    const core = boot('a');
    core.telegram.answers.push({ approved: true, scope: 'always' }, false);
    const model = new ScriptedModel();
    model.script(
      ...clickOn('#b1'),
      say('Enviado.'),
      ...clickOn('#b1'),
      call('browser', { action: 'click', selector: '#b2' }),
      say('Enviado; borrar no me dejaste.'),
    );
    const t = await core.thread();
    await t.user('dale a enviar');
    await t.user('otra vez enviar, y luego borra los mensajes');
    await settle();
    expect(core.telegram.approvals.map((a) => a.approved)).toEqual([true, false]);
    expect(core.telegram.approvals[1]?.question).toContain('Borrar mensajes');
    expect(hits).toEqual(['send', 'send']);
  }, 60_000);

  // approval_scopes guarda el chat: un «Siempre» dado en el privado de Nico no
  // vale en otro chat ni en un grupo.
  it('el «Siempre» de un chat no vale en otro chat', async () => {
    const core = boot('b');
    core.telegram.answers.push({ approved: true, scope: 'always' }, false);
    const model = new ScriptedModel();
    model.script(...clickOn('#b1'), say('Enviado.'), ...clickOn('#b1'), say('Sin permiso.'));
    await (await core.thread()).user('dale a enviar');
    await (await core.thread('777')).user('dale a enviar');
    await settle();
    expect(core.telegram.approvals.map((a) => [a.chatId, a.approved])).toEqual([
      ['424242', true],
      ['777', false],
    ]);
    expect(hits).toEqual(['send']);
  }, 60_000);

  it('un «Enviar» que cambia de texto vuelve a preguntar', async () => {
    const core = boot('c');
    core.telegram.answers.push({ approved: true, scope: 'always' }, false);
    const model = new ScriptedModel();
    model.script(
      ...clickOn('#b1'),
      say('Enviado.'),
      ...clickOn('#b1', 'Enviar transferencia de 900 €'),
      say('Sin permiso.'),
    );
    const t = await core.thread();
    await t.user('dale a enviar');
    await t.user('dale a enviar otra vez');
    await settle();
    expect(core.telegram.approvals.map((a) => a.approved)).toEqual([true, false]);
    expect(hits).toEqual(['send']);
  }, 60_000);

  it('el «Siempre» sobrevive a reiniciar el daemon', async () => {
    const first = boot('d');
    first.telegram.answers.push({ approved: true, scope: 'always' });
    const model = new ScriptedModel();
    model.script(...clickOn('#b1'), say('Enviado.'), ...clickOn('#b1'), say('Enviado.'));
    await (await first.thread()).user('dale a enviar');
    stopAll();
    const second = boot('d');
    await (await second.thread()).user('dale a enviar');
    await settle();
    expect(first.telegram.approvals).toHaveLength(1);
    expect(second.telegram.approvals).toHaveLength(0);
    expect(hits).toEqual(['send', 'send']);
  }, 60_000);
  it('en una página de dinero o cuenta, «Siempre» no se guarda: vuelve a preguntar', async () => {
    const core = boot('e');
    core.telegram.answers.push({ approved: true, scope: 'always' }, false);
    const model = new ScriptedModel();
    model.script(
      ...clickOn('#b1', 'Enviar', 'Mi cuenta bancaria'),
      say('Enviado.'),
      ...clickOn('#b1', 'Enviar', 'Mi cuenta bancaria'),
      say('Sin permiso.'),
    );
    const t = await core.thread();
    await t.user('dale a enviar');
    await t.user('dale a enviar otra vez');
    await settle();
    expect(core.telegram.approvals.map((a) => a.approved)).toEqual([true, false]);
    expect(core.telegram.approvals[0]?.question).toContain('dinero o credenciales');
    expect(hits).toEqual(['send']);
  }, 60_000);
});

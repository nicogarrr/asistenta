import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Computer Use de punta a punta con una pantalla falsa: modelo guionizado, Gate de
 * producción (createDaemonGate), agente y herramienta `computer` reales; solo la
 * capa del sistema operativo (ratón, teclado, captura) es falsa y registra lo que
 * se habría hecho. Ningún test mueve el ratón ni captura la pantalla real.
 */
const root = mkdtempSync(join(tmpdir(), 'pa-e2e-computer-'));
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

const { Core, ScriptedModel, call, say, E2E_CONFIG, threadKey, CHAT_ID } = await import(
  './helpers/e2e-core.js'
);
const { createComputerTool } = await import('../src/tools/computer.js');
type ScreenBackend = import('../src/tools/computer.js').ScreenBackend;
type Gate = import('../src/permissions.js').Gate;

/** Pantalla falsa: 1920x1080 reales, capturas de 800x450 (screenshotMaxEdge del e2e). */
function fakeScreen(did: string[]): ScreenBackend {
  let shots = 0;
  return {
    screenshot: async () => {
      shots++;
      did.push('screenshot');
      return {
        image: Buffer.from(`frame-${shots}`),
        mimeType: 'image/jpeg',
        width: 800,
        height: 450,
        nativeWidth: 1920,
        nativeHeight: 1080,
      };
    },
    click: async (x, y) => {
      did.push(`click:${x},${y}`);
    },
    move: async (x, y) => {
      did.push(`move:${x},${y}`);
    },
    drag: async (x, y, toX, toY) => {
      did.push(`drag:${x},${y}->${toX},${toY}`);
    },
    type: async (text) => {
      did.push(`type:${text}`);
    },
    key: async (key) => {
      did.push(`key:${key}`);
    },
    screenSize: async () => ({ width: 1920, height: 1080 }),
  };
}

let seq = 0;
const cores: InstanceType<typeof Core>[] = [];

/** Un Core con la herramienta `computer` cableada como en cli.ts: el Gate del hilo decide. */
function boot(): {
  core: InstanceType<typeof Core>;
  did: string[];
  bind: (chatId?: string) => AgentTool;
} {
  const core = new Core(join(root, `c${++seq}`)).start();
  const did: string[] = [];
  const screen = fakeScreen(did);
  cores.push(core);
  const bind = (chatId = CHAT_ID): AgentTool => {
    const key = threadKey(chatId);
    return createComputerTool(E2E_CONFIG, screen, (c) => {
      const gate = core.threads.get(key)?.gate as Gate | undefined;
      if (!gate) throw new Error('hilo sin Gate');
      return gate.check(key, { ...c, actor: 'asistenta' });
    }) as unknown as AgentTool;
  };
  core.extraTools = [bind()];
  return { core, did, bind };
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
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('Computer Use de punta a punta (pantalla falsa)', () => {
  it('una captura no pide permiso', async () => {
    const { core, did } = boot();
    const model = new ScriptedModel();
    model.script(call('computer', { action: 'screenshot' }), say('Veo el escritorio.'));
    const t = await core.thread();
    const r = await t.user('¿qué hay en mi pantalla?');
    expect(r.error).toBeNull();
    expect(core.telegram.approvals).toHaveLength(0);
    expect(did).toEqual(['screenshot']);
  });

  it('un clic pregunta y, sin «sí», el ratón no se mueve', async () => {
    const { core, did } = boot();
    const model = new ScriptedModel();
    model.script(
      call('computer', { action: 'screenshot' }),
      call('computer', { action: 'click', x: 400, y: 225 }),
      say('No me has dejado hacer clic.'),
    );
    const t = await core.thread();
    await t.user('pulsa el botón de en medio');
    expect(core.telegram.approvals).toHaveLength(1);
    expect(did).toEqual(['screenshot']);
  });

  it('con «sí» el clic cae en el píxel real y la ventana de 90 s cubre el «escribir» siguiente, no Win+R', async () => {
    const { core, did } = boot();
    core.telegram.answers.push(true); // el clic
    const model = new ScriptedModel();
    model.script(
      call('computer', { action: 'screenshot' }),
      call('computer', { action: 'click', x: 400, y: 225 }),
      call('computer', { action: 'type', text: 'hola' }),
      call('computer', { action: 'key', key: 'win+r' }),
      say('Hecho, salvo abrir «Ejecutar».'),
    );
    const t = await core.thread();
    await t.user('escribe hola en el cuadro del centro');
    // Captura 800x450 de una pantalla 1920x1080: (400,225) → (960,540).
    expect(did.slice(0, 3)).toEqual(['screenshot', 'click:960,540', 'type:hola']);
    expect(did).not.toContain('key:win+r');
    expect(core.telegram.approvals.map((a) => a.approved)).toEqual([true, false]);
  });

  it('el permiso de un turno no vale para el siguiente', async () => {
    const { core, did } = boot();
    core.telegram.answers.push(true);
    const model = new ScriptedModel();
    model.script(
      call('computer', { action: 'click', x: 10, y: 10 }),
      say('Listo.'),
      call('computer', { action: 'click', x: 20, y: 20 }),
      say('No me dejaste.'),
    );
    const t = await core.thread();
    await t.user('pulsa arriba a la izquierda');
    await t.user('y otra vez un poco más abajo');
    expect(core.telegram.approvals.map((a) => a.approved)).toEqual([true, false]);
    expect(did.filter((d) => d.startsWith('click'))).toHaveLength(1);
  });

  it('el permiso de un chat no vale en otro chat a la vez', async () => {
    const { core, did, bind } = boot();
    core.telegram.answers.push(true, false);
    const model = new ScriptedModel();
    model.script(
      call('computer', { action: 'click', x: 10, y: 10 }),
      call('computer', { action: 'click', x: 20, y: 20 }),
      say('Listo.'),
      say('Listo.'),
    );
    const a = await core.thread();
    core.extraTools = [bind('777')];
    const b = await core.thread('777');
    await Promise.all([a.user('pulsa arriba'), b.user('pulsa arriba')]);
    // Cada chat pregunta por su clic: el «sí» de uno no abre la ventana del otro.
    expect(core.telegram.approvals.map((x) => x.chatId).sort()).toEqual(['424242', '777']);
    expect(did.filter((d) => d.startsWith('click'))).toHaveLength(1);
  });

  it('un lote con un clic pregunta antes de ejecutar nada', async () => {
    const { core, did } = boot();
    const model = new ScriptedModel();
    model.script(
      call('computer', {
        action: 'batch',
        actions: [
          { action: 'click', x: 100, y: 100 },
          { action: 'type', text: 'borrar todo' },
          { action: 'key', key: 'enter' },
        ],
      }),
      say('Sin permiso.'),
    );
    const t = await core.thread();
    await t.user('rellena el formulario');
    expect(core.telegram.approvals.length).toBeGreaterThanOrEqual(1);
    expect(did.filter((d) => !d.startsWith('screenshot'))).toEqual([]);
  });
});

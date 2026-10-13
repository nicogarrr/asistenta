import { describe, expect, it } from 'vitest';
import {
  type FetchLike,
  IphoneClient,
  IphoneError,
  type IphoneStatus,
  normalizeBaseUrl,
  readiness,
  setupGuide,
} from '../src/iphone/client.js';
import { Gate } from '../src/permissions.js';
import { createIphoneTool, type IphoneToolDeps } from '../src/tools/iphone.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 3)]);

const READY: IphoneStatus = {
  device: true,
  screen: true,
  calibrated: true,
  models: { planner: 'p', actor: 'a' },
  agent: { running: false, task: null, steps: 0 },
};

type Result = {
  content: { type: string; text?: string; data?: string }[];
  details: Record<string, unknown>;
};

function setup(statuses: IphoneStatus[], over: Partial<IphoneToolDeps> = {}) {
  const calls: string[] = [];
  let i = 0;
  const deps: IphoneToolDeps = {
    status: async () => {
      calls.push('status');
      return statuses[Math.min(i++, statuses.length - 1)] as IphoneStatus;
    },
    frame: async () => {
      calls.push('frame');
      return JPEG;
    },
    start: async (g) => void calls.push(`start:${g}`),
    stop: async () => void calls.push('stop'),
    home: async () => void calls.push('home'),
    sleep: async () => undefined,
    ...over,
  };
  const tool = createIphoneTool(deps);
  const run = (args: Record<string, unknown>) =>
    tool.execute('t', args as never) as unknown as Promise<Result>;
  return { run, calls };
}

describe('readiness', () => {
  it('lista lo que falta, en orden', () => {
    expect(readiness(READY)).toEqual([]);
    const all = readiness({ ...READY, device: false, screen: false, calibrated: false });
    expect(all).toHaveLength(3);
    expect(all[0]).toMatch(/ESP32/);
    expect(all[1]).toMatch(/Duplicar pantalla/);
    expect(all[2]).toMatch(/calibrado/);
  });
});

describe('iphone tool', () => {
  it('status: listo y no listo, con el motivo', async () => {
    const ok = await setup([READY]).run({ action: 'status' });
    expect(ok.content[0]?.text).toMatch(/^Listo/);
    expect(ok.details.ready).toBe(true);
    const bad = await setup([{ ...READY, device: false }]).run({ action: 'status' });
    expect(bad.content[0]?.text).toMatch(/NO listo: la ESP32/);
    expect(bad.details.ready).toBe(false);
  });

  it('screenshot devuelve la imagen en base64', async () => {
    const r = await setup([READY]).run({ action: 'screenshot' });
    expect(r.content[1]?.data).toBe(JPEG.toString('base64'));
  });

  it('run exige goal y NO toca el telefono sin el', async () => {
    const s = setup([READY]);
    await expect(s.run({ action: 'run' })).rejects.toThrow(/goal/);
    await expect(s.run({ action: 'run', goal: '   ' })).rejects.toThrow(/goal/);
    expect(s.calls).toEqual([]);
  });

  it('run se niega si el puente no esta listo y no arranca nada', async () => {
    const s = setup([{ ...READY, calibrated: false }]);
    await expect(s.run({ action: 'run', goal: 'abre Ajustes' })).rejects.toThrow(/calibrado/);
    expect(s.calls.some((c) => c.startsWith('start'))).toBe(false);
  });

  it('run se niega si ya hay una tarea en marcha', async () => {
    const s = setup([{ ...READY, agent: { running: true, task: 'otra', steps: 2 } }]);
    await expect(s.run({ action: 'run', goal: 'x' })).rejects.toThrow(/otra/);
    expect(s.calls.some((c) => c.startsWith('start'))).toBe(false);
  });

  it('run arranca, espera a que pare y devuelve pasos + captura, sin afirmar exito', async () => {
    const running = { ...READY, agent: { running: true, task: 'g', steps: 2 } };
    const done = { ...READY, agent: { running: false, task: 'g', steps: 5 } };
    const s = setup([READY, running, done]);
    const r = await s.run({ action: 'run', goal: 'abre Ajustes' });
    expect(s.calls[0]).toBe('status');
    expect(s.calls).toContain('start:abre Ajustes');
    expect(r.details).toMatchObject({ finished: true, steps: 5, verified: false });
    expect(r.content[0]?.text).toMatch(/5 pasos/);
    expect(r.content[0]?.text).toMatch(/NO prueba/);
    expect(r.content[1]?.data).toBe(JPEG.toString('base64'));
  });

  it('run con waitSeconds=0 no espera y lo dice', async () => {
    const running = { ...READY, agent: { running: true, task: 'g', steps: 1 } };
    const s = setup([READY, running]);
    const r = await s.run({ action: 'run', goal: 'g', waitSeconds: 0 });
    expect(r.details.finished).toBe(false);
    expect(r.content[0]?.text).toMatch(/Sigue en marcha/);
  });

  it('run sigue si falla la captura final', async () => {
    const done = { ...READY, agent: { running: false, task: 'g', steps: 1 } };
    const s = setup([READY, done], {
      frame: async () => {
        throw new Error('sin pantalla');
      },
    });
    const r = await s.run({ action: 'run', goal: 'g' });
    expect(r.content[1]?.text).toMatch(/No pude capturar/);
  });

  it('stop y home pasan por el servidor', async () => {
    const s = setup([READY]);
    await s.run({ action: 'stop' });
    await s.run({ action: 'home' });
    expect(s.calls).toEqual(['stop', 'status', 'home']);
  });

  it('stop NO espera a un run en curso: deps.stop se llama mientras run sigue sondeando', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const done = { ...READY, agent: { running: false, task: 'g', steps: 2 } };
    const s = setup([READY, done], { sleep: () => gate });
    let runDone = false;
    const runP = s.run({ action: 'run', goal: 'g', waitSeconds: 600 }).then((r) => {
      runDone = true;
      return r;
    });
    // Deja que run llegue a su espera.
    await new Promise((r) => setTimeout(r, 20));
    expect(s.calls).toContain('start:g');
    await s.run({ action: 'stop' });
    expect(s.calls).toContain('stop');
    expect(runDone).toBe(false);
    release();
    await runP;
  });

  it('home se niega si hay una tarea en marcha y no toca el telefono', async () => {
    const running = { ...READY, agent: { running: true, task: 'g', steps: 1 } };
    const s = setup([running]);
    await expect(s.run({ action: 'home' })).rejects.toThrow(/action=stop/);
    expect(s.calls).not.toContain('home');
  });
});

function fakeFetch(
  handler: (url: string, init?: { method?: string; body?: string }) => unknown,
): FetchLike {
  return async (url, init) => {
    const out = handler(url, init) as {
      status?: number;
      json?: unknown;
      bytes?: Buffer;
      text?: string;
    };
    const status = out.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => out.json,
      text: async () => out.text ?? '',
      arrayBuffer: async () => {
        const b = out.bytes ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  };
}

describe('IphoneClient', () => {
  it('normaliza la URL y rechaza lo que no es http(s)', () => {
    expect(normalizeBaseUrl('http://192.168.1.50:8890/')).toBe('http://192.168.1.50:8890');
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow(IphoneError);
    expect(() => normalizeBaseUrl('no es una url')).toThrow(IphoneError);
  });

  it('status mapea la forma real de /api/status', async () => {
    const f = fakeFetch(() => ({
      json: {
        device: true,
        screen: false,
        calibrated: true,
        debug: false,
        models: { planner: 'm1', actor: 'm2' },
        agent: { running: true, task: 'x', steps: 3 },
      },
    }));
    const s = await new IphoneClient({ baseUrl: 'http://h:8890', fetch: f }).status();
    expect(s).toEqual({
      device: true,
      screen: false,
      calibrated: true,
      models: { planner: 'm1', actor: 'm2' },
      agent: { running: true, task: 'x', steps: 3 },
    });
  });

  it('status tolera campos ausentes sin inventar true', async () => {
    const f = fakeFetch(() => ({ json: {} }));
    const s = await new IphoneClient({ baseUrl: 'http://h', fetch: f }).status();
    expect(s.device).toBe(false);
    expect(s.agent).toEqual({ running: false, task: null, steps: 0 });
  });

  it('start manda {text: goal} a /api/agent por POST', async () => {
    let seen: { url: string; method?: string; body?: string } | null = null;
    const f = fakeFetch((url, init) => {
      seen = { url, method: init?.method, body: init?.body };
      return { json: { ok: true } };
    });
    await new IphoneClient({ baseUrl: 'http://h:8890', fetch: f }).start('abre Ajustes');
    expect(seen).toEqual({
      url: 'http://h:8890/api/agent',
      method: 'POST',
      body: JSON.stringify({ text: 'abre Ajustes' }),
    });
  });

  it('frame devuelve los bytes; un 404 sale como error legible', async () => {
    const ok = new IphoneClient({ baseUrl: 'http://h', fetch: fakeFetch(() => ({ bytes: JPEG })) });
    expect((await ok.frame()).equals(JPEG)).toBe(true);
    const no = new IphoneClient({
      baseUrl: 'http://h',
      fetch: fakeFetch(() => ({ status: 404, text: 'no live screen' })),
    });
    await expect(no.frame()).rejects.toThrow(/404.*no live screen/);
  });

  it('un fallo de red explica como comprobarlo', async () => {
    const f: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(new IphoneClient({ baseUrl: 'http://h', fetch: f }).status()).rejects.toThrow(
      /No llego al servidor del iPhone.*ECONNREFUSED/,
    );
  });
});

describe('iphone: clasificacion de efecto', () => {
  const gate = new Gate({ allowUntilPayment: true, approver: () => true });
  const at = (args: Record<string, unknown>) =>
    gate.classifyEffect({ tool: 'iphone', args, actor: 'test' });

  it('status y screenshot son lecturas; run, stop, home y lo desconocido son opacos (preguntan)', () => {
    expect(at({ action: 'status' })).toBe('lee');
    expect(at({ action: 'screenshot' })).toBe('lee');
    expect(at({ action: 'run', goal: 'sube el video' })).toBeNull();
    expect(at({ action: 'stop' })).toBeNull();
    expect(at({ action: 'home' })).toBeNull();
    expect(at({ action: 'otra' })).toBeNull();
    expect(at({})).toBeNull();
  });
});

describe('alta guiada (setup)', () => {
  it('sin servidor: primer paso falta y dice como arrancarlo', async () => {
    const { run } = setup([READY], {
      status: async () => {
        throw new IphoneError('no llego');
      },
    });
    const r = await run({ action: 'setup' });
    expect(r.details.ready).toBe(false);
    expect(r.content[0]?.text).toMatch(/Siguiente: Servidor del iPhone: no responde \(no llego\)/);
    expect(r.content[0]?.text).toMatch(/1\. \[falta\]/);
  });

  it('marca lo hecho y apunta al primer paso pendiente, en orden', () => {
    const g = setupGuide({ ...READY, screen: false, calibrated: false });
    expect(g.steps.map((s) => s.done)).toEqual([true, true, false, false, true]);
    expect(g.next).toMatch(/Duplicar pantalla/);
  });

  it('todo listo: sin siguiente paso y sin tocar el telefono', async () => {
    const { run, calls } = setup([READY]);
    const r = await run({ action: 'setup' });
    expect(r.details.ready).toBe(true);
    expect(r.content[0]?.text).toMatch(/completa/);
    expect(calls).toEqual(['status']);
  });

  it('el modelo sin configurar tambien cuenta como paso pendiente', () => {
    const g = setupGuide({ ...READY, models: { planner: '', actor: '' } });
    expect(g.next).toMatch(/LLM_API_KEY/);
  });

  it('setup es una lectura para el gestor de permisos', () => {
    const gate = new Gate({ allowUntilPayment: true, approver: () => true });
    expect(gate.classifyEffect({ tool: 'iphone', args: { action: 'setup' }, actor: 'test' })).toBe(
      'lee',
    );
  });
});

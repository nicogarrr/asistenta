// Velocidad de la tele (asis-velocidad-1): sesión SSAP persistente.
// Antes cada orden abría wss + registro y cada tecla esperaba 800 ms antes de
// cerrar: 5 flechas = 5 conexiones y ~7 s. Con TvSessionPool, una conexión.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TvSessionPool,
  tvKey,
  tvKeyGapMs,
  tvKeys,
  tvRequest,
  tvSessionIdleMs,
} from '../src/tv/lgtv.js';

const HOST = '192.168.1.50';

interface Counters {
  opens: number;
  registers: number;
  requests: string[];
  inputOpens: number;
  keys: string[];
  pings: number;
}

function fakeTv(opts: { pong?: boolean; newKey?: string; failUri?: string } = {}) {
  const c: Counters = { opens: 0, registers: 0, requests: [], inputOpens: 0, keys: [], pings: 0 };
  const sockets: FakeWs[] = [];
  const inputs: FakeInput[] = [];
  class FakeWs extends EventEmitter {
    closed = false;
    /** Muerte silenciosa: el socket deja de contestar SIN emitir close. */
    silence = false;
    constructor() {
      super();
      c.opens += 1;
      sockets.push(this);
      setImmediate(() => this.emit('open'));
    }
    override off(e: string, f: (...a: unknown[]) => void) {
      return this.removeListener(e, f);
    }
    send(data: string) {
      if (this.closed) throw new Error('socket cerrado');
      if (this.silence) return;
      const m = JSON.parse(data);
      setImmediate(() => {
        if (this.closed) return;
        if (m.type === 'register') {
          c.registers += 1;
          this.emit(
            'message',
            JSON.stringify({
              id: m.id,
              type: 'registered',
              payload: { 'client-key': opts.newKey ?? 'KEY' },
            }),
          );
          return;
        }
        c.requests.push(m.uri);
        if (opts.failUri && m.uri.endsWith(opts.failUri)) {
          this.cut();
          return;
        }
        const payload: Record<string, unknown> = { returnValue: true };
        if (m.uri.endsWith('getPointerInputSocket')) {
          payload.socketPath = `wss://${HOST}:3001/resources/x/netinput.pointer.sock`;
        }
        this.emit('message', JSON.stringify({ id: m.id, type: 'response', payload }));
      });
    }
    ping() {
      c.pings += 1;
      if (opts.pong !== false) setImmediate(() => this.emit('pong'));
    }
    cut() {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    }
    close() {
      this.cut();
    }
  }
  class FakeInput extends EventEmitter {
    closed = false;
    constructor() {
      super();
      c.inputOpens += 1;
      inputs.push(this);
      setImmediate(() => this.emit('open'));
    }
    override off(e: string, f: (...a: unknown[]) => void) {
      return this.removeListener(e, f);
    }
    send(data: string) {
      if (this.closed) throw new Error('input cerrado');
      c.keys.push(/name:(\w+)/.exec(data)?.[1] ?? '?');
    }
    ping() {
      if (opts.pong !== false) setImmediate(() => this.emit('pong'));
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    }
  }
  return {
    c,
    sockets,
    inputs,
    deps: (pool?: TvSessionPool) => ({
      factory: () => new FakeWs(),
      inputFactory: () => new FakeInput(),
      keyGraceMs: 50,
      ...(pool ? { pool } : {}),
    }),
  };
}

const pools: TvSessionPool[] = [];
const newPool = (o: ConstructorParameters<typeof TvSessionPool>[0] = {}) => {
  const p = new TvSessionPool({ keyGapMs: 0, ...o });
  pools.push(p);
  return p;
};
afterEach(() => {
  for (const p of pools.splice(0)) p.closeAll();
  delete process.env.PA_TV_SESSION_IDLE_MS;
  delete process.env.PA_TV_KEY_GAP_MS;
});

describe('sesión persistente con la LG', () => {
  it('sin pool: cada tecla abre su conexión (comportamiento de siempre)', async () => {
    const tv = fakeTv();
    for (const k of ['DOWN', 'DOWN', 'ENTER']) await tvKey(HOST, 'KEY', k, tv.deps());
    expect(tv.c.opens).toBe(3);
    expect(tv.c.registers).toBe(3);
    expect(tv.c.inputOpens).toBe(3);
    expect(tv.c.keys).toEqual(['DOWN', 'DOWN', 'ENTER']);
  });

  it('con pool: 5 teclas = 1 conexión, 1 registro, 1 socket de input', async () => {
    const tv = fakeTv();
    const pool = newPool();
    for (const k of ['DOWN', 'DOWN', 'DOWN', 'DOWN', 'ENTER']) {
      await tvKey(HOST, 'KEY', k, tv.deps(pool));
    }
    expect(tv.c.opens).toBe(1);
    expect(tv.c.registers).toBe(1);
    expect(tv.c.inputOpens).toBe(1);
    expect(tv.c.keys).toEqual(['DOWN', 'DOWN', 'DOWN', 'DOWN', 'ENTER']);
    expect(pool.answeredWithin(HOST, 1_000)).toBe(true);
  });

  it('con pool: las teclas no esperan la gracia de 800 ms', async () => {
    const tv = fakeTv();
    const pool = newPool();
    const d = { ...tv.deps(pool), keyGraceMs: 2_000 };
    await tvKey(HOST, 'KEY', 'HOME', d);
    const t = Date.now();
    for (let i = 0; i < 4; i += 1) await tvKey(HOST, 'KEY', 'RIGHT', d);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('una ráfaga (tvKeys) con pool reutiliza la conexión entre ráfagas', async () => {
    const tv = fakeTv();
    const pool = newPool();
    await tvKeys(HOST, 'KEY', ['DOWN', 'DOWN', 'ENTER'], { ...tv.deps(pool), keyGapMs: 0 });
    await tvKeys(HOST, 'KEY', ['BACK', 'BACK'], { ...tv.deps(pool), keyGapMs: 0 });
    expect(tv.c.opens).toBe(1);
    expect(tv.c.inputOpens).toBe(1);
    expect(tv.c.keys).toEqual(['DOWN', 'DOWN', 'ENTER', 'BACK', 'BACK']);
  });

  it('respeta la pausa entre teclas (keyGapMs)', async () => {
    const tv = fakeTv();
    const pool = newPool();
    const d = { ...tv.deps(pool), keyGapMs: 60 };
    const t = Date.now();
    for (let i = 0; i < 3; i += 1) await tvKey(HOST, 'KEY', 'UP', d);
    expect(Date.now() - t).toBeGreaterThanOrEqual(115);
  });

  it('peticiones seguidas reutilizan la conexión', async () => {
    const tv = fakeTv();
    const pool = newPool();
    await tvRequest(HOST, 'KEY', 'system.launcher/launch', { id: 'netflix' }, tv.deps(pool));
    await tvRequest(
      HOST,
      'KEY',
      'com.webos.applicationManager/getForegroundAppInfo',
      {},
      tv.deps(pool),
    );
    expect(tv.c.opens).toBe(1);
    expect(tv.c.registers).toBe(1);
    expect(tv.c.requests).toHaveLength(2);
  });

  it('si la tele cierra la conexión, la siguiente orden abre otra', async () => {
    const tv = fakeTv();
    const pool = newPool();
    await tvRequest(HOST, 'KEY', 'system.launcher/launch', { id: 'netflix' }, tv.deps(pool));
    tv.sockets[0]?.cut();
    await tvRequest(HOST, 'KEY', 'system.launcher/launch', { id: 'youtube' }, tv.deps(pool));
    expect(tv.c.opens).toBe(2);
    expect(tv.c.registers).toBe(2);
  });

  it('sesión muerta en silencio (sin close): la tecla sale en una conexión nueva', async () => {
    const tv = fakeTv();
    // pingAfterMs alto: como si la muerte fuera de hace <5 s, el pool no llega a hacer ping.
    const pool = newPool({ pingAfterMs: 60_000 });
    const deps = { ...tv.deps(pool), commandTimeoutMs: 100 };
    await pool.key(HOST, 'KEY', 'RIGHT', deps);
    expect(tv.c.keys).toEqual(['RIGHT']);
    // La tele se apaga de golpe: el TCP queda a medias (sin close) y el
    // socket de input muere con ella. El request del input expira con
    // «no respondio»: la tecla aún no se había enviado, toca reabrir una vez.
    const sesion = tv.sockets[0];
    const entrada = tv.inputs[0];
    if (!sesion || !entrada) throw new Error('el fake no abrió los sockets esperados');
    sesion.silence = true;
    entrada.close();
    await pool.key(HOST, 'KEY', 'LEFT', deps);
    expect(tv.c.keys).toEqual(['RIGHT', 'LEFT']);
    expect(tv.c.opens).toBe(2);
    expect(tv.c.inputOpens).toBe(2);
  });

  it('sesión parada sin pong: se tira antes de enviar nada', async () => {
    let now = 1_000;
    const tv = fakeTv({ pong: false });
    const pool = newPool({ now: () => now, pingAfterMs: 5_000 });
    await tvRequest(HOST, 'KEY', 'system.launcher/launch', { id: 'netflix' }, tv.deps(pool));
    now += 10_000;
    await tvRequest(HOST, 'KEY', 'system.launcher/launch', { id: 'youtube' }, tv.deps(pool));
    expect(tv.c.pings).toBe(1);
    expect(tv.c.opens).toBe(2);
    // La orden salió una sola vez por cada llamada.
    expect(tv.c.requests).toEqual([
      'ssap://system.launcher/launch',
      'ssap://system.launcher/launch',
    ]);
  }, 10_000);

  it('una orden cortada a medias NO se repite (no duplicar launch)', async () => {
    const tv = fakeTv({ failUri: 'system.launcher/launch' });
    const pool = newPool();
    await tvRequest(
      HOST,
      'KEY',
      'com.webos.applicationManager/getForegroundAppInfo',
      {},
      tv.deps(pool),
    );
    await expect(
      tvRequest(HOST, 'KEY', 'system.launcher/launch', { id: 'netflix' }, tv.deps(pool)),
    ).rejects.toThrow(/cerro la conexion/);
    expect(tv.c.requests.filter((u) => u.endsWith('launch'))).toHaveLength(1);
  });

  it('una lectura cortada en una sesión reutilizada se repite una vez en limpio', async () => {
    const tv = fakeTv();
    const pool = newPool();
    await tvRequest(HOST, 'KEY', 'system.launcher/launch', { id: 'netflix' }, tv.deps(pool));
    // La tele corta justo al llegar la lectura (p. ej. se reinició su servidor).
    const first = tv.sockets[0];
    const origSend = first?.send.bind(first);
    if (first && origSend) {
      first.send = (data: string) => {
        if (data.includes('getForegroundAppInfo')) {
          setImmediate(() => first.cut());
          return;
        }
        origSend(data);
      };
    }
    const res = await tvRequest(
      HOST,
      'KEY',
      'com.webos.applicationManager/getForegroundAppInfo',
      {},
      tv.deps(pool),
    );
    expect(res.returnValue).toBe(true);
    expect(tv.c.opens).toBe(2);
  });

  it('tele re-emparejada (otra client-key): la conexión no se guarda', async () => {
    const tv = fakeTv({ newKey: 'NUEVA' });
    const pool = newPool();
    const saved: string[] = [];
    const d = { ...tv.deps(pool), onNewClientKey: (k: string) => void saved.push(k) };
    await tvRequest(HOST, 'VIEJA', 'system.launcher/launch', { id: 'netflix' }, d);
    expect(saved).toEqual(['NUEVA']);
    expect(pool.size()).toBe(0);
    expect(tv.sockets[0]?.closed).toBe(true);
  });

  it('se cierra sola tras la inactividad', async () => {
    const tv = fakeTv();
    const pool = newPool({ idleMs: 30 });
    await tvKey(HOST, 'KEY', 'HOME', tv.deps(pool));
    expect(pool.size()).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(tv.sockets[0]?.closed).toBe(true);
    expect(tv.inputs[0]?.closed).toBe(true);
    expect(pool.size()).toBe(0);
  });

  it('socket de input cerrado por la tele: la siguiente tecla lo reabre', async () => {
    const tv = fakeTv();
    const pool = newPool();
    await tvKey(HOST, 'KEY', 'HOME', tv.deps(pool));
    tv.inputs[0]?.close();
    await tvKey(HOST, 'KEY', 'BACK', tv.deps(pool));
    expect(tv.c.opens).toBe(1);
    expect(tv.c.inputOpens).toBe(2);
    expect(tv.c.keys).toEqual(['HOME', 'BACK']);
  });

  it('teclas fuera de la lista siguen rechazadas con pool', async () => {
    const tv = fakeTv();
    await expect(tvKey(HOST, 'KEY', 'HOME\nname:POWER', tv.deps(newPool()))).rejects.toThrow(
      /Tecla no valida/,
    );
    expect(tv.c.opens).toBe(0);
  });

  it('knobs: PA_TV_SESSION_IDLE_MS=0 la apaga; la pausa entre teclas es la de las ráfagas', () => {
    expect(tvSessionIdleMs()).toBe(60_000);
    process.env.PA_TV_SESSION_IDLE_MS = '0';
    expect(tvSessionIdleMs()).toBe(0);
    expect(tvKeyGapMs()).toBe(150);
  });
});

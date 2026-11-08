import { X509Certificate } from 'node:crypto';
import https from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { makeSelfSignedCert } from '../src/aim/cert.js';
import { apuntarCommand, lanIps } from '../src/aim/cli.js';
import type { AimSink } from '../src/aim/engine.js';
import {
  AIM_MAX_FAILURES,
  type AimServer,
  isLanAddress,
  parseAimMessage,
  startAimServer,
} from '../src/aim/server.js';
import { TeleSink } from '../src/aim/tele.js';
import { WINDOWS_MOUSE_SCRIPT, type WindowsChild, WindowsSink } from '../src/aim/windows.js';
import type { TvInputSocket } from '../src/tv/lgtv.js';
import { FakeWebOsTv } from './helpers/fake-webos-tv.js';

describe('certificado autofirmado', () => {
  it('es un X.509 válido con la IP en los nombres, firmado con su propia clave', () => {
    const c = makeSelfSignedCert(['192.168.1.50', '10.0.0.7']);
    const x = new X509Certificate(c.cert);
    expect(x.subjectAltName).toContain('IP Address:192.168.1.50');
    expect(x.subjectAltName).toContain('IP Address:10.0.0.7');
    expect(x.subjectAltName).toContain('DNS:localhost');
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.ca).toBe(false);
    const dias = (Date.parse(x.validTo) - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(29);
    expect(dias).toBeLessThan(31);
  });
  it('rechaza una IP que no es IPv4', () => {
    expect(() => makeSelfSignedCert(['no-es-ip'])).toThrow(/IP no válida/);
    expect(() => makeSelfSignedCert(['300.1.1.1'])).toThrow(/IP no válida/);
  });
});

describe('parseAimMessage', () => {
  it('acepta los mensajes buenos', () => {
    expect(parseAimMessage('{"k":"m","t":1,"g":[0,1,2],"r":[3,4,5]}')).toEqual({
      k: 'm',
      t: 1,
      g: [0, 1, 2],
      r: [3, 4, 5],
    });
    expect(parseAimMessage('{"k":"down","t":2}')).toEqual({ k: 'down', t: 2 });
    expect(parseAimMessage('{"k":"center"}')).toEqual({ k: 'center' });
    expect(parseAimMessage('{"k":"pause","on":true}')).toEqual({ k: 'pause', on: true });
    expect(parseAimMessage('{"k":"invert","el":true}')).toEqual({ k: 'invert', el: true });
  });
  it('descarta lo raro: texto, tipos mal, números no finitos, demasiado largo', () => {
    for (const bad of [
      'no json',
      '[]',
      'null',
      '{"k":"zzz"}',
      '{"k":"m","t":"1","g":[0,1,2],"r":[3,4,5]}',
      '{"k":"m","t":1,"g":[0,1],"r":[3,4,5]}',
      '{"k":"m","t":1,"g":[0,1,null],"r":[3,4,5]}',
      '{"k":"scroll","dy":"9"}',
      '{"k":"pause","on":"si"}',
      `{"k":"center","x":"${'a'.repeat(600)}"}`,
    ]) {
      expect(parseAimMessage(bad), bad).toBeNull();
    }
  });
});

describe('isLanAddress', () => {
  it('solo la red de casa', () => {
    for (const ok of [
      '192.168.1.5',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.9.9',
      '::ffff:192.168.1.5',
      '127.0.0.1',
      'fe80::1',
    ]) {
      expect(isLanAddress(ok), ok).toBe(true);
    }
    for (const bad of ['8.8.8.8', '172.32.0.1', '203.0.113.9', '::ffff:8.8.8.8', '', undefined]) {
      expect(isLanAddress(bad), String(bad)).toBe(false);
    }
  });
});

function fakeSink() {
  const calls: string[] = [];
  const sink: AimSink = {
    screen: { w: 1000, h: 500 },
    absolute: true,
    moveTo: (x, y) => calls.push(`M ${x} ${y}`),
    down: () => calls.push('D'),
    up: () => calls.push('U'),
    right: () => calls.push('R'),
    scroll: (dy) => calls.push(`S ${dy}`),
  };
  return { sink, calls };
}

describe('servidor HTTPS + WebSocket', () => {
  let srv: AimServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  const get = (port: number, path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port, path, rejectUnauthorized: false }, (res) => {
          let body = '';
          res.on('data', (c) => {
            body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });
  const open = (port: number, token: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/ws?t=${token}`, {
        rejectUnauthorized: false,
      });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('sirve la página solo con la clave y mueve el destino con los mensajes del móvil', async () => {
    const { sink, calls } = fakeSink();
    srv = await startAimServer({ sink, ips: ['127.0.0.1'], port: 0, token: 'abc123' });
    expect((await get(srv.port, '/')).status).toBe(403);
    const ok = await get(srv.port, '/?t=abc123');
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('Empezar');
    const ws = await open(srv.port, 'abc123');
    ws.send('{"k":"m","t":0,"g":[0,0,9.8],"r":[0,0,0]}');
    ws.send('{"k":"center"}');
    ws.send('{"k":"m","t":0.01,"g":[0,0,9.8],"r":[0,0,0]}');
    ws.send('basura');
    ws.send('{"k":"right"}');
    await wait(100);
    expect(calls).toContain('M 500 250');
    expect(calls.at(-1)).toBe('R');
    ws.close();
  });

  it('con la clave mal, rechaza y a los 5 fallos bloquea hasta la buena', async () => {
    const { sink } = fakeSink();
    srv = await startAimServer({ sink, ips: ['127.0.0.1'], port: 0, token: 'buena1' });
    for (let i = 0; i < AIM_MAX_FAILURES; i++)
      await expect(open(srv.port, 'mala')).rejects.toThrow();
    await expect(open(srv.port, 'buena1')).rejects.toThrow(/403/);
    expect((await get(srv.port, '/?t=buena1')).status).toBe(403);
  });

  it('solo un móvil a la vez y al soltar la conexión suelta el botón', async () => {
    const { sink, calls } = fakeSink();
    srv = await startAimServer({ sink, ips: ['127.0.0.1'], port: 0, token: 'k1k1k1' });
    const a = await open(srv.port, 'k1k1k1');
    await expect(open(srv.port, 'k1k1k1')).rejects.toThrow(/403/);
    a.send('{"k":"down","t":1}');
    await wait(50);
    expect(calls).toContain('D');
    a.terminate();
    await wait(100);
    expect(calls.at(-1)).toBe('U');
  });
});

function fakeChild() {
  const lines: string[] = [];
  let onData: ((c: string) => void) | undefined;
  const exits: Array<(...a: unknown[]) => void> = [];
  let killed = false;
  const child: WindowsChild = {
    stdin: { write: (l: string) => lines.push(l.trimEnd()), end: () => undefined },
    stdout: {
      on: (_e, cb) => {
        onData = cb as (c: string) => void;
      },
    },
    on: (e, cb) => {
      if (e === 'exit') exits.push(cb);
    },
    kill: () => {
      killed = true;
    },
  };
  return {
    child,
    lines,
    say: (s: string) => onData?.(s),
    exit: () => {
      for (const f of exits) f();
    },
    killed: () => killed,
  };
}

describe('WindowsSink', () => {
  it('lee el tamaño de la pantalla y manda una orden por línea', async () => {
    const f = fakeChild();
    const p = WindowsSink.open(() => f.child, 1000);
    f.say('2560 1440\r\n');
    const s = await p;
    expect(s.screen).toEqual({ w: 2560, h: 1440 });
    s.moveTo(10.4, 20.6);
    s.down();
    s.up();
    s.right();
    s.scroll(10);
    s.scroll(0);
    expect(f.lines).toEqual(['M 10 21', 'D', 'U', 'R', 'S 30']);
    s.close();
    expect(f.killed()).toBe(true);
  });
  it('si PowerShell se cierra o no contesta, error claro', async () => {
    const f = fakeChild();
    const p = WindowsSink.open(() => f.child, 1000);
    f.exit();
    await expect(p).rejects.toThrow(/se cerró/);
    const g = fakeChild();
    await expect(WindowsSink.open(() => g.child, 20)).rejects.toThrow(/no contestó/);
    expect(g.killed()).toBe(true);
  });
  it('el guion usa user32 con DPI real y entiende las cinco órdenes', () => {
    for (const k of [
      'SetProcessDPIAware',
      'SetCursorPos',
      'mouse_event',
      "'M'",
      "'D'",
      "'U'",
      "'R'",
      "'S'",
    ]) {
      expect(WINDOWS_MOUSE_SCRIPT).toContain(k);
    }
  });
});

describe('TeleSink', () => {
  function setup() {
    const tv = new FakeWebOsTv();
    const frames: string[] = [];
    let closed = false;
    const inputFactory = (): TvInputSocket => {
      let onOpen: (() => void) | undefined;
      setTimeout(() => onOpen?.(), 0);
      return {
        on: (e, cb) => {
          if (e === 'open') onOpen = cb as () => void;
        },
        send: (d: string) => {
          frames.push(d);
        },
        close: () => {
          closed = true;
        },
      };
    };
    return { tv, frames, inputFactory, closed: () => closed };
  }

  it('pide el socket de puntero a la tele y manda move/click/scroll/atrás en su formato', async () => {
    const { tv, frames, inputFactory } = setup();
    const s = await TeleSink.open(
      '192.168.1.50',
      'KEY123',
      { factory: tv.factory, inputFactory },
      1,
    );
    expect(tv.requests.map((r) => r.uri)).toContain(
      'com.webos.service.networkinput/getPointerInputSocket',
    );
    s.moveBy(3.2, -4.7, false);
    s.moveBy(0.4, 0.4, false); // acumula, no manda
    s.down();
    s.moveBy(10, 0, true);
    s.up(0.2);
    s.down();
    s.up(1.2); // arrastre largo: no hay clic
    s.right();
    s.scroll(25);
    s.scroll(0);
    expect(frames).toEqual([
      'type:move\ndx:3\ndy:-4\ndown:0\n\n',
      'type:move\ndx:10\ndy:0\ndown:1\n\n',
      'type:click\n\n',
      'type:button\nname:BACK\n\n',
      'type:scroll\ndx:0\ndy:25\n\n',
    ]);
  });
  it('arrastra el resto decimal para no perder movimiento lento', async () => {
    const { tv, frames, inputFactory } = setup();
    const s = await TeleSink.open('192.168.1.50', 'KEY123', { factory: tv.factory, inputFactory });
    for (let i = 0; i < 5; i++) s.moveBy(0.4, 0, false);
    expect(frames).toEqual([
      'type:move\ndx:1\ndy:0\ndown:0\n\n',
      'type:move\ndx:1\ndy:0\ndown:0\n\n',
    ]);
  });
  it('no acepta una IP que no es de la red local', async () => {
    const { tv, inputFactory } = setup();
    await expect(
      TeleSink.open('8.8.8.8', 'KEY123', { factory: tv.factory, inputFactory }),
    ).rejects.toThrow(/Host de tele/);
  });
});

describe('pa apuntar', () => {
  it('sin destino da el uso; con puerto malo, error', async () => {
    const out: string[] = [];
    expect(await apuntarCommand([], { print: (l) => out.push(l) })).toBe(1);
    expect(out.join('\n')).toContain('uso: pa apuntar pc|tele');
    const out2: string[] = [];
    expect(
      await apuntarCommand(['pc', '--puerto', '80'], {
        print: (l) => out2.push(l),
        ips: ['192.168.1.5'],
      }),
    ).toBe(1);
    expect(out2.join('\n')).toContain('puerto');
  });
  it('sin red de casa no arranca', async () => {
    const out: string[] = [];
    expect(await apuntarCommand(['pc'], { print: (l) => out.push(l), ips: [] })).toBe(1);
    expect(out.join('\n')).toContain('red de casa');
  });
  it('imprime la URL con la clave y el aviso del certificado, y cierra todo al parar', async () => {
    const out: string[] = [];
    const { sink } = fakeSink();
    let closedSink = false;
    let closedServer = false;
    const code = await apuntarCommand(['tele'], {
      print: (l) => out.push(l),
      ips: ['192.168.1.5'],
      openTele: async () =>
        Object.assign(sink, {
          close: () => {
            closedSink = true;
          },
        }),
      start: async () =>
        ({
          port: 8443,
          token: 'tok123',
          close: async () => {
            closedServer = true;
          },
        }) as unknown as AimServer,
      waitStop: async () => undefined,
    });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('https://192.168.1.5:8443/?t=tok123');
    expect(text).toContain('certificado propio');
    expect(text).toContain('se ve en la tele');
    expect(closedSink && closedServer).toBe(true);
  });
  it('lanIps solo da IPv4 privadas y externas al equipo', () => {
    const ips = lanIps({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      eth: [
        { address: '192.168.1.5', family: 'IPv4', internal: false } as never,
        { address: '8.8.4.4', family: 'IPv4', internal: false } as never,
        { address: 'fe80::1', family: 'IPv6', internal: false } as never,
      ],
    });
    expect(ips).toEqual(['192.168.1.5']);
  });
});

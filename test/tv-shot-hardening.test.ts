/**
 * Endurecimiento de tvScreenshot/tvKey (auditor, 11 oct): el imageUri y el
 * socketPath vienen de RED y solo valen si apuntan a la propia tele; la
 * firma de imagen se valida completa; y la tecla jamas se confirma si el
 * socket se cerro antes de tiempo.
 */

import { EventEmitter } from 'node:events';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TV_HOST = '192.168.1.237';

/** Socket SSAP falso: register OK y la response dada para cualquier request. */
function ssapSocket(responsePayload: Record<string, unknown>) {
  return class extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    close() {
      this.emit('close');
    }
    send(raw: string) {
      const m = JSON.parse(raw);
      queueMicrotask(() =>
        this.emit(
          'message',
          JSON.stringify(
            m.type === 'register'
              ? { id: m.id, type: 'registered', payload: { 'client-key': 'k' } }
              : { id: m.id, type: 'response', payload: responsePayload },
          ),
        ),
      );
    }
  };
}

class FakeReq extends EventEmitter {
  setTimeout(_ms: number, _cb: () => void) {}
  destroy(err?: Error) {
    if (err) this.emit('error', err);
  }
}

class FakeRes extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  constructor(status: number, contentType: string) {
    super();
    this.statusCode = status;
    this.headers = contentType ? { 'content-type': contentType } : {};
  }
  resume() {}
  destroy() {}
}

/** Mock de node:https: registra las URLs pedidas y sirve status/bytes dados. */
function mockHttps(status: number, contentType: string, chunks: Buffer[]) {
  const downloaded: string[] = [];
  vi.doMock('node:https', () => ({
    default: {
      get: (url: string, _opts: unknown, cb: (r: FakeRes) => void) => {
        downloaded.push(String(url));
        const req = new FakeReq();
        const res = new FakeRes(status, contentType);
        queueMicrotask(() => {
          cb(res);
          for (const c of chunks) res.emit('data', c);
          res.emit('end');
        });
        return req;
      },
    },
  }));
  return downloaded;
}

async function loadLgtv(responsePayload: Record<string, unknown>) {
  vi.resetModules();
  const mod = await import('../src/tv/lgtv.js');
  const factory = () => new (ssapSocket(responsePayload))();
  return { mod, factory };
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1024, 1)]);

afterEach(() => {
  vi.doUnmock('node:https');
  vi.doUnmock('ws');
});

describe('tvScreenshot endurecido', () => {
  it('rechaza un imageUri a un host externo sin descargar nada', async () => {
    const downloaded = mockHttps(200, 'image/jpeg', [JPEG]);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      imageUri: 'https://attacker.invalid/image',
    });
    await expect(
      mod.tvScreenshot(TV_HOST, 'k', { factory, commandTimeoutMs: 50 }),
    ).rejects.toThrow();
    expect(downloaded).toEqual([]);
  });

  it('rechaza imageUri con credenciales embebidas', async () => {
    const downloaded = mockHttps(200, 'image/jpeg', [JPEG]);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      imageUri: `https://user:pw@${TV_HOST}:3001/x.jpg`,
    });
    await expect(
      mod.tvScreenshot(TV_HOST, 'k', { factory, commandTimeoutMs: 50 }),
    ).rejects.toThrow();
    expect(downloaded).toEqual([]);
  });

  it('rechaza imageUri en un puerto desconocido', async () => {
    const downloaded = mockHttps(200, 'image/jpeg', [JPEG]);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      imageUri: `https://${TV_HOST}:9999/x.jpg`,
    });
    await expect(
      mod.tvScreenshot(TV_HOST, 'k', { factory, commandTimeoutMs: 50 }),
    ).rejects.toThrow();
    expect(downloaded).toEqual([]);
  });

  it('no sigue redirects (3xx) aunque el host sea la tele', async () => {
    mockHttps(302, 'image/jpeg', [JPEG]);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      imageUri: `https://${TV_HOST}:3001/capture.jpg`,
    });
    await expect(mod.tvScreenshot(TV_HOST, 'k', { factory, commandTimeoutMs: 50 })).rejects.toThrow(
      /302/,
    );
  });

  it('rechaza content-type que no es imagen', async () => {
    mockHttps(200, 'text/html', [JPEG]);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      imageUri: `https://${TV_HOST}:3001/capture.jpg`,
    });
    await expect(mod.tvScreenshot(TV_HOST, 'k', { factory, commandTimeoutMs: 50 })).rejects.toThrow(
      /content-type/,
    );
  });

  it('rechaza 2 bytes con prefijo FF D8 (firma incompleta)', async () => {
    mockHttps(200, 'image/jpeg', [Buffer.from([0xff, 0xd8])]);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      imageUri: `https://${TV_HOST}:3001/capture.jpg`,
    });
    await expect(mod.tvScreenshot(TV_HOST, 'k', { factory, commandTimeoutMs: 50 })).rejects.toThrow(
      /firma JPEG\/PNG/,
    );
  });

  it('acepta un JPEG valido servido por la propia tele', async () => {
    mockHttps(200, 'image/jpeg', [JPEG]);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      imageUri: `https://${TV_HOST}:3001/capture.jpg`,
    });
    const bytes = await mod.tvScreenshot(TV_HOST, 'k', { factory, commandTimeoutMs: 50 });
    expect(bytes.length).toBe(JPEG.length);
  });
});

describe('tvKey endurecido', () => {
  function pointerSocket(closeEarly: boolean) {
    const sent: string[] = [];
    vi.doMock('ws', () => ({
      default: class extends EventEmitter {
        constructor() {
          super();
          queueMicrotask(() => this.emit('open'));
          if (closeEarly) setTimeout(() => this.emit('close'), 10);
        }
        close() {
          this.emit('close');
        }
        send(data: string) {
          sent.push(data);
        }
      },
    }));
    return sent;
  }

  it('rechaza un nombre de tecla fuera de la whitelist', async () => {
    pointerSocket(false);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      socketPath: `wss://${TV_HOST}:3001/resources/netinput.pointer.sock`,
    });
    await expect(
      mod.tvKey(TV_HOST, 'k', 'no-existe', { factory, commandTimeoutMs: 50 }),
    ).rejects.toThrow(/Tecla no valida/);
  });

  it('rechaza un nombre con CRLF (inyeccion de botones al protocolo)', async () => {
    const sent = pointerSocket(false);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      socketPath: `wss://${TV_HOST}:3001/resources/netinput.pointer.sock`,
    });
    await expect(
      mod.tvKey(TV_HOST, 'k', 'HOME\nname:BACK', { factory, commandTimeoutMs: 50 }),
    ).rejects.toThrow(/Tecla no valida/);
    expect(sent).toEqual([]);
  });

  it('rechaza un socketPath a otro host', async () => {
    pointerSocket(false);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      socketPath: 'wss://192.168.1.99:3001/resources/netinput.pointer.sock',
    });
    await expect(
      mod.tvKey(TV_HOST, 'k', 'HOME', { factory, commandTimeoutMs: 50 }),
    ).rejects.toThrow(/no valido/);
  });

  it('falla si el socket de input se cierra antes de tiempo (sin falso OK)', async () => {
    pointerSocket(true);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      socketPath: `wss://${TV_HOST}:3001/resources/netinput.pointer.sock`,
    });
    await expect(
      mod.tvKey(TV_HOST, 'k', 'HOME', { factory, commandTimeoutMs: 50 }),
    ).rejects.toThrow(/cerro el socket/);
  });

  it('resuelve solo tras el margen de consumo con el socket vivo', async () => {
    const sent = pointerSocket(false);
    const { mod, factory } = await loadLgtv({
      returnValue: true,
      socketPath: `wss://${TV_HOST}:3001/resources/netinput.pointer.sock`,
    });
    await mod.tvKey(TV_HOST, 'k', 'home', { factory, commandTimeoutMs: 50 });
    expect(sent).toEqual(['type:button\nname:HOME\n\n']);
  }, 3000);
});

describe('CLI shot endurecido', () => {
  it('--key sin nombre sale 2 antes de tocar el vault', async () => {
    const { tvCommand } = await import('../src/tv/tv-cli.js');
    await expect(tvCommand(['shot', '--key'])).resolves.toBe(2);
  });

  it('no sobrescribe un fichero existente sin --force', async () => {
    const out = join(tmpdir(), `tv-shot-test-${process.pid}.jpg`);
    writeFileSync(out, 'ocupado');
    try {
      const { tvCommand } = await import('../src/tv/tv-cli.js');
      await expect(tvCommand(['shot', out])).resolves.toBe(2);
    } finally {
      unlinkSync(out);
    }
  });

  it('flag desconocido sale 2', async () => {
    const { tvCommand } = await import('../src/tv/tv-cli.js');
    await expect(tvCommand(['shot', '--borrame'])).resolves.toBe(2);
  });
});

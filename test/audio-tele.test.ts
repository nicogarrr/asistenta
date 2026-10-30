import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeRemote, pickLanAddress, serveFileToHost } from '../src/audio/lan-server.js';
import { audioTeleEnabled, castAudioToTv, tvCasterFromVault } from '../src/audio/tv-cast.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const playAudioFile = vi.fn();
vi.mock('../src/tools/system.js', () => ({
  playAudioFile: (...a: unknown[]) => playAudioFile(...a),
  playbackRestoreText: () => 'Volumen restaurado.',
}));
const toPlayableAudio = vi.fn();
vi.mock('../src/screen/media.js', () => ({
  toPlayableAudio: (...a: unknown[]) => toPlayableAudio(...a),
  captureCameraFrame: vi.fn(),
  recordCamera: vi.fn(),
  recordCameraWithMic: vi.fn(),
  recordMicrophone: vi.fn(),
  consumeRecording: vi.fn(),
}));

const { AudioRecall } = await import('../src/media/recall.js');
const { createMediaTool } = await import('../src/tools/media.js');

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-audio-tele-'));
  playAudioFile.mockReset();
  toPlayableAudio.mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fetchLocal(
  url: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('pickLanAddress', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    eth: [
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', internal: false },
      { address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', internal: false },
    ],
    vpn: [{ address: '100.64.0.5', netmask: '255.192.0.0', family: 'IPv4', internal: false }],
  };
  it('elige la IPv4 del PC que está en la subred de la tele', () => {
    expect(pickLanAddress('192.168.1.50', ifaces)).toBe('192.168.1.20');
  });
  it('no adivina: sin subred común devuelve null (ni loopback ni VPN)', () => {
    expect(pickLanAddress('10.0.0.7', ifaces)).toBeNull();
    expect(pickLanAddress('tele.local', ifaces)).toBeNull();
  });
  it('normaliza direcciones IPv4 mapeadas en IPv6', () => {
    expect(normalizeRemote('::ffff:192.168.1.50')).toBe('192.168.1.50');
  });
});

describe('serveFileToHost', () => {
  it('sirve el fichero solo en su ruta, con Range, y lo borra al cerrar', async () => {
    const file = join(dir, 'a.mp3');
    writeFileSync(file, Buffer.from('0123456789'));
    const s = await serveFileToHost({ file, bindIp: '127.0.0.1', allowIp: '127.0.0.1' });
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a\/[0-9a-f]{32}\.mp3$/);
    const full = await fetchLocal(s.url);
    expect(full.status).toBe(200);
    expect(full.body.toString()).toBe('0123456789');
    expect(full.headers['content-type']).toBe('audio/mpeg');
    const part = await fetchLocal(s.url, { headers: { Range: 'bytes=2-4' } });
    expect(part.status).toBe(206);
    expect(part.body.toString()).toBe('234');
    expect((await fetchLocal(s.url.replace(/\/a\/.*/, '/a/otro.mp3'))).status).toBe(404);
    expect((await fetchLocal(s.url, { method: 'POST' })).status).toBe(405);
    expect((await fetchLocal(s.url, { headers: { Range: 'bytes=50-60' } })).status).toBe(416);
    s.close();
    await s.closed;
    expect(existsSync(file)).toBe(false);
  });

  it('rechaza cualquier IP que no sea la de la tele', async () => {
    const file = join(dir, 'b.mp3');
    writeFileSync(file, 'x');
    const s = await serveFileToHost({ file, bindIp: '127.0.0.1', allowIp: '192.168.1.50' });
    expect((await fetchLocal(s.url)).status).toBe(403);
    expect(s.hits()).toBe(0);
    s.close();
  });

  it('se cierra solo al vencer el ttl', async () => {
    const file = join(dir, 'c.mp3');
    writeFileSync(file, 'x');
    const s = await serveFileToHost({
      file,
      bindIp: '127.0.0.1',
      allowIp: '127.0.0.1',
      ttlMs: 30,
    });
    await s.closed;
    expect(existsSync(file)).toBe(false);
  });
});

describe('castAudioToTv', () => {
  const fakeServe = () => {
    const close = vi.fn();
    return {
      close,
      serve: vi.fn(async () => ({
        url: 'http://192.168.1.20:5555/a/tok.mp3',
        close,
        closed: Promise.resolve(),
        hits: () => 0,
      })),
    };
  };

  it('usa el visor multimedia de webOS con la URL efímera', async () => {
    const { serve, close } = fakeServe();
    const ssap = vi.fn(async () => ({ returnValue: true }));
    const r = await castAudioToTv(join(dir, 'x.mp3'), {
      tvHost: '192.168.1.50',
      ssap,
      pickAddress: () => '192.168.1.20',
      serve,
    });
    expect(r).toMatchObject({ ok: true, via: 'media.viewer' });
    expect(ssap).toHaveBeenCalledWith(
      'media.viewer/open',
      expect.objectContaining({
        target: 'http://192.168.1.20:5555/a/tok.mp3',
        mimeType: 'audio/mpeg',
      }),
    );
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({ allowIp: '192.168.1.50' }));
    expect(close).not.toHaveBeenCalled();
  });

  it('si no hay visor prueba el lanzador; si nada funciona cierra el servidor', async () => {
    const a = fakeServe();
    const ssap = vi.fn(async (uri: string) => {
      if (uri === 'media.viewer/open') throw new Error('404 no such service');
      return {};
    });
    const r = await castAudioToTv('f', {
      tvHost: '192.168.1.50',
      ssap,
      pickAddress: () => '192.168.1.20',
      serve: a.serve,
    });
    expect(r).toMatchObject({ ok: true, via: 'launcher' });

    const b = fakeServe();
    const r2 = await castAudioToTv('f', {
      tvHost: '192.168.1.50',
      ssap: async () => {
        throw new Error('apagada');
      },
      pickAddress: () => '192.168.1.20',
      serve: b.serve,
    });
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('apagada');
    expect(b.close).toHaveBeenCalled();
  });

  it('sin subred común no abre nada y borra la copia', async () => {
    const file = join(dir, 'y.mp3');
    writeFileSync(file, 'x');
    const serve = vi.fn();
    const r = await castAudioToTv(file, {
      tvHost: '192.168.1.50',
      ssap: vi.fn(),
      pickAddress: () => null,
      serve,
    });
    expect(r.ok).toBe(false);
    expect(serve).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('tvCasterFromVault sin emparejar no toca la red', async () => {
    const file = join(dir, 'z.mp3');
    writeFileSync(file, 'x');
    const req = vi.fn();
    const r = await tvCasterFromVault(async () => null, req)(file);
    expect(r.message).toContain('pa tv setup');
    expect(req).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('PA_AUDIO_TELE apagado por defecto', () => {
    expect(audioTeleEnabled({})).toBe(false);
    expect(audioTeleEnabled({ PA_AUDIO_TELE: '1' })).toBe(true);
  });
});

describe('media action=play (caracterización + target)', () => {
  const CHAT = 'telegram:personal:1';
  const setup = (extra: Record<string, unknown> = {}) => {
    const recall = new AudioRecall({});
    recall.record(CHAT, { fileId: 'F1', mimeType: 'audio/ogg', messageId: '10' });
    const tool = createMediaTool({
      chatKey: CHAT,
      recall,
      downloadAudio: async () => Buffer.from('OggS'),
      chatId: '1',
      maxEdge: 1280,
      sendPhoto: async () => '1',
      sendVideo: async () => true,
      sendVoice: async () => true,
      ...extra,
    });
    return tool;
  };
  const text = (r: { content: unknown[] }) =>
    (r.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('');

  it('PC (por defecto): convierte, reproduce al volumen pedido y borra la copia', async () => {
    const mp3 = join(dir, 'p.mp3');
    writeFileSync(mp3, 'x');
    toPlayableAudio.mockResolvedValue(mp3);
    playAudioFile.mockResolvedValue({ ok: true, seconds: 3, volumeSet: 40 });
    const r = await setup().execute('c', { action: 'play', volume: 40 });
    expect(playAudioFile).toHaveBeenCalledWith(mp3, { volume: 40 });
    expect(r.details).toMatchObject({ played: true, seconds: 3 });
    expect(existsSync(mp3)).toBe(false);
  });

  it('PC: un fallo del reproductor se cuenta, no se lanza', async () => {
    toPlayableAudio.mockResolvedValue(join(dir, 'q.mp3'));
    playAudioFile.mockResolvedValue({ ok: false, detail: 'sin dispositivo', seconds: 0 });
    const r = await setup().execute('c', { action: 'play' });
    expect(r.details).toMatchObject({ played: false });
    expect(text(r)).toContain('sin dispositivo');
  });

  it('tele apagada: lo dice y no convierte nada', async () => {
    const r = await setup().execute('c', { action: 'play', target: 'tele' });
    expect(r.details).toMatchObject({ played: false, reason: 'tele off' });
    expect(text(r)).toContain('PA_AUDIO_TELE');
    expect(toPlayableAudio).not.toHaveBeenCalled();
  });

  it('tele: entrega el MP3 al caster y no toca los altavoces del PC', async () => {
    const mp3 = join(dir, 't.mp3');
    writeFileSync(mp3, 'x');
    toPlayableAudio.mockResolvedValue(mp3);
    const castToTv = vi.fn(async () => ({ ok: true, message: 'He mandado el audio a la tele' }));
    const r = await setup({ castToTv }).execute('c', { action: 'play', target: 'tele' });
    expect(castToTv).toHaveBeenCalledWith(mp3);
    expect(playAudioFile).not.toHaveBeenCalled();
    expect(r.details).toMatchObject({ played: true, target: 'tele' });
    // el fichero es ahora del caster (lo borra cuando la tele lo ha bajado)
    expect(readFileSync(mp3, 'utf8')).toBe('x');
  });
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));
vi.mock('../src/tools/system.js', () => ({
  playAudioFile: vi.fn(),
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
  dir = mkdtempSync(join(tmpdir(), 'pa-media-tele-stop-cast-'));
  toPlayableAudio.mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tool(extra: Record<string, unknown>) {
  const recall = new AudioRecall({});
  recall.record('telegram:a:1#main', { fileId: 'F1', mimeType: 'audio/ogg', messageId: '10' });
  return createMediaTool({
    chatKey: 'telegram:a:1#main',
    recall,
    downloadAudio: async () => Buffer.from('ogg'),
    chatId: '1',
    maxEdge: 1280,
    sendPhoto: async () => '1',
    sendVideo: async () => true,
    sendVoice: async () => true,
    ...extra,
  } as never);
}

describe('«reprodúcelo en la tele»: /stop mientras la tele abre el audio', () => {
  it('/stop llega durante el envío: se para ESTE cast, se cierra su servidor y no se apunta', async () => {
    const mp3 = join(dir, 't.mp3');
    writeFileSync(mp3, 'x');
    toPlayableAudio.mockResolvedValue(mp3);
    const ac = new AbortController();
    const stop = vi.fn(async () => {});
    const close = vi.fn();
    const onTeleCast = vi.fn();
    const castToTv = vi.fn(async () => {
      // Conectar con la tele tarda: /stop (abort del turno) llega en medio.
      ac.abort();
      return { ok: true, message: 'En la tele', stop, close };
    });
    const res = await tool({ castToTv, onTeleCast }).execute(
      'c',
      { action: 'play', target: 'tele' },
      ac.signal,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(onTeleCast).not.toHaveBeenCalled();
    expect((res.details as { played: boolean }).played).toBe(false);
  });

  it('/stop antes de enviar: no se manda nada a la tele y la copia se borra', async () => {
    const mp3 = join(dir, 't.mp3');
    writeFileSync(mp3, 'x');
    const ac = new AbortController();
    toPlayableAudio.mockImplementation(async () => {
      ac.abort();
      return mp3;
    });
    const castToTv = vi.fn(async () => ({ ok: true, message: 'En la tele' }));
    const res = await tool({ castToTv }).execute(
      'c',
      { action: 'play', target: 'tele' },
      ac.signal,
    );
    expect(castToTv).not.toHaveBeenCalled();
    expect(existsSync(mp3)).toBe(false);
    expect((res.details as { played: boolean }).played).toBe(false);
  });

  it('sin /stop todo sigue igual: se apunta el «parar» del cast y no se cierra nada', async () => {
    const mp3 = join(dir, 't.mp3');
    writeFileSync(mp3, 'x');
    toPlayableAudio.mockResolvedValue(mp3);
    const stop = vi.fn(async () => {});
    const close = vi.fn();
    const onTeleCast = vi.fn();
    const castToTv = vi.fn(async () => ({ ok: true, message: 'En la tele', stop, close }));
    const ac = new AbortController();
    await tool({ castToTv, onTeleCast }).execute(
      'c',
      { action: 'play', target: 'tele' },
      ac.signal,
    );
    expect(onTeleCast).toHaveBeenCalledWith(stop);
    expect(stop).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

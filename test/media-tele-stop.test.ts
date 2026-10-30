import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const { createAltavozPlayer } = await import('../src/audio/altavoz.js');

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-media-tele-stop-'));
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

describe('«reprodúcelo en la tele» y /stop', () => {
  it('la tele aceptó: entrega el «parar» de ESTE cast a quien lleva /stop', async () => {
    const mp3 = join(dir, 't.mp3');
    writeFileSync(mp3, 'x');
    toPlayableAudio.mockResolvedValue(mp3);
    const stop = vi.fn(async () => {});
    const onTeleCast = vi.fn();
    const castToTv = vi.fn(async () => ({ ok: true, message: 'En la tele', stop }));
    await tool({ castToTv, onTeleCast }).execute('c', { action: 'play', target: 'tele' });
    expect(onTeleCast).toHaveBeenCalledTimes(1);
    expect(onTeleCast.mock.calls[0]?.[0]).toBe(stop);
  });

  it('la tele rechazó la orden: no apunta nada (/stop no toca la tele)', async () => {
    const mp3 = join(dir, 'u.mp3');
    writeFileSync(mp3, 'x');
    toPlayableAudio.mockResolvedValue(mp3);
    const onTeleCast = vi.fn();
    const castToTv = vi.fn(async () => ({ ok: false, message: 'No responde' }));
    await tool({ castToTv, onTeleCast }).execute('c', { action: 'play', target: 'tele' });
    expect(onTeleCast).not.toHaveBeenCalled();
  });
});

describe('AltavozPlayer.noteTele', () => {
  const base = (now: () => number, stopTv = vi.fn(async () => {})) => ({
    p: createAltavozPlayer({
      toPlayable: async () => 'x',
      playOnPc: async () => {},
      stopTv,
      now,
      remove: () => {},
    }),
    stopTv,
  });

  it('/stop en ese chat usa el «parar» del cast (no el genérico) y cuenta 1', () => {
    const { p, stopTv } = base(() => 1_000);
    const stop = vi.fn(async () => {});
    p.noteTele('telegram:a:1', stop);
    expect(p.clear('telegram:a:1')).toBe(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopTv).not.toHaveBeenCalled();
    // ya parado: un segundo /stop no vuelve a tocar la tele
    expect(p.clear('telegram:a:1')).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('/stop de OTRO chat no toca la tele', () => {
    const { p, stopTv } = base(() => 1_000);
    const stop = vi.fn(async () => {});
    p.noteTele('telegram:a:1', stop);
    expect(p.clear('telegram:a:2')).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(stopTv).not.toHaveBeenCalled();
  });

  it('pasados 2 min la tele ya no se toca (puede estar con otra cosa)', () => {
    let t = 1_000;
    const { p, stopTv } = base(() => t);
    const stop = vi.fn(async () => {});
    p.noteTele('telegram:a:1', stop);
    t += 120_001;
    expect(p.clear('telegram:a:1')).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(stopTv).not.toHaveBeenCalled();
  });

  it('sin «parar» propio usa el genérico (media.controls/stop)', () => {
    const { p, stopTv } = base(() => 1_000);
    p.noteTele('telegram:a:1');
    expect(p.clear('telegram:a:1')).toBe(1);
    expect(stopTv).toHaveBeenCalledTimes(1);
  });
});

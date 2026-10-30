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
const { createAltavozPlayer } = await import('../src/audio/altavoz.js');
const { createMediaTool, resetTeleFirewallWarning } = await import('../src/tools/media.js');

/** «Reprodúcelo en la tele»: la tele acepta pero no descarga → aviso del firewall al chat. */
const CHAT = 'telegram:personal:1';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-media-fw-'));
  const mp3 = join(dir, 't.mp3');
  writeFileSync(mp3, 'x');
  toPlayableAudio.mockResolvedValue(mp3);
  resetTeleFirewallWarning();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function tool(
  hits: () => number,
  notices: string[],
  onTeleCast?: (s?: () => Promise<unknown>) => unknown,
) {
  const recall = new AudioRecall({});
  recall.record(CHAT, { fileId: 'F1', mimeType: 'audio/ogg', messageId: '10' });
  return createMediaTool({
    chatKey: CHAT,
    recall,
    downloadAudio: async () => Buffer.from('OggS'),
    chatId: '1',
    maxEdge: 1280,
    sendPhoto: async () => '1',
    sendVideo: async () => true,
    sendVoice: async () => true,
    castToTv: async () => ({ ok: true, message: 'mandado', hits, stop: async () => {} }),
    notifyChat: (t) => notices.push(t),
    teleNoFetchMs: 1_000,
    ...(onTeleCast ? { onTeleCast } : {}),
  });
}

const note = async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' });

// La tele no pide el fichero porque el usuario la paró con /stop a los pocos segundos:
// avisar del firewall a los 15 s es un aviso falso.
describe('aviso del firewall tras /stop', () => {
  it('«reprodúcelo en la tele» + /stop antes del plazo: no avisa del firewall', async () => {
    const notices: string[] = [];
    const player = createAltavozPlayer({
      toPlayable: async () => join(dir, 't.mp3'),
      playOnPc: async () => {},
      remove: () => {},
    });
    const t = tool(
      () => 0,
      notices,
      (stop) => player.noteTele(CHAT, stop),
    );
    const r = await t.execute('c1', { action: 'play', target: 'tele' });
    expect(JSON.stringify(r)).toContain('mandado');
    expect(player.clear(CHAT)).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(notices).toEqual([]);
  });

  it('sin /stop sigue avisando (la tele no pidió el fichero)', async () => {
    const notices: string[] = [];
    const player = createAltavozPlayer({
      toPlayable: async () => join(dir, 't.mp3'),
      playOnPc: async () => {},
      remove: () => {},
    });
    const t = tool(
      () => 0,
      notices,
      (stop) => player.noteTele(CHAT, stop),
    );
    await t.execute('c1', { action: 'play', target: 'tele' });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(notices.length).toBe(1);
  });

  it('/altavoz tele + /stop antes del plazo: no avisa del firewall', async () => {
    const notices: string[] = [];
    const player = createAltavozPlayer({
      toPlayable: async () => join(dir, 't.mp3'),
      playOnPc: async () => {},
      castToTv: async () => ({ ok: true, message: 'ok', hits: () => 0, stop: async () => {} }),
      remove: () => {},
      noFetchMs: 1_000,
    });
    player.enqueue('tele', note, undefined, CHAT, (x) => notices.push(x));
    await player.idle();
    expect(player.clear(CHAT)).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(notices).toEqual([]);
  });
});

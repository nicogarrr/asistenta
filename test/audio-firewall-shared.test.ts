import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';
import { TV_FIREWALL_HINT } from '../src/audio/tv-cast.js';

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
const { createMediaTool, resetTeleFirewallWarning } = await import('../src/tools/media.js');

/**
 * El aviso del firewall es uno por sesión del daemon en total: si ya salió por /altavoz
 * tele, «reprodúcelo en la tele» no lo repite, y al revés.
 */
const CHAT = 'telegram:personal:1';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-fw-shared-'));
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

function tool(hits: (() => number) | undefined, notices: string[], ok = true) {
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
    castToTv: async () => ({ ok, message: ok ? 'mandado' : 'la tele no responde', hits }),
    notifyChat: (t) => notices.push(t),
    teleNoFetchMs: 1_000,
  });
}

function altavoz(hits: () => number) {
  return createAltavozPlayer({
    toPlayable: async () => join(dir, 't.mp3'),
    playOnPc: async () => {},
    castToTv: async () => ({ ok: true, message: 'ok', hits }),
    remove: () => {},
    noFetchMs: 1_000,
  });
}
const note = async () => ({ bytes: Buffer.from('x'), mimeType: 'audio/ogg' });

describe('aviso del firewall compartido entre /altavoz tele y «reprodúcelo en la tele»', () => {
  it('después del aviso del altavoz, la herramienta de medios no lo repite', async () => {
    const notices: string[] = [];
    const p = altavoz(() => 0);
    p.enqueue('tele', note, undefined, CHAT, (t) => notices.push(t));
    await p.idle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices).toEqual([`📺 ${TV_FIREWALL_HINT}`]);
    await tool(() => 0, notices).execute('c', { action: 'play', target: 'tele' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notices).toHaveLength(1);
  });

  it('después del aviso de la herramienta, el altavoz no lo repite', async () => {
    const notices: string[] = [];
    await tool(() => 0, notices).execute('c', { action: 'play', target: 'tele' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices).toHaveLength(1);
    const p = altavoz(() => 0);
    p.enqueue('tele', note, undefined, CHAT, (t) => notices.push(t));
    await p.idle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notices).toHaveLength(1);
  });

  it('dos avisos pendientes a la vez: solo sale uno', async () => {
    const notices: string[] = [];
    const p = altavoz(() => 0);
    p.enqueue('tele', note, undefined, CHAT, (t) => notices.push(t));
    await p.idle();
    await tool(() => 0, notices).execute('c', { action: 'play', target: 'tele' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notices).toHaveLength(1);
  });
});

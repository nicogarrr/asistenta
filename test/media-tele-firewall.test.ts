import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('media play tele: aviso de firewall', () => {
  it('la respuesta no espera; si la tele no descarga en el plazo, avisa al chat', async () => {
    const notices: string[] = [];
    const r = await tool(() => 0, notices).execute('c', { action: 'play', target: 'tele' });
    expect(r.details).toMatchObject({ played: true, target: 'tele' });
    expect(notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices).toEqual([`📺 ${TV_FIREWALL_HINT}`]);
  });

  it('si la tele lo descarga, nada', async () => {
    const notices: string[] = [];
    await tool(() => 2, notices).execute('c', { action: 'play', target: 'tele' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notices).toEqual([]);
  });

  it('una sola vez por sesión', async () => {
    const notices: string[] = [];
    await tool(() => 0, notices).execute('c', { action: 'play', target: 'tele' });
    await vi.advanceTimersByTimeAsync(1_000);
    await tool(() => 0, notices).execute('c', { action: 'play', target: 'tele' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices).toHaveLength(1);
  });

  it('orden rechazada o caster sin hits: sin aviso de firewall', async () => {
    const notices: string[] = [];
    await tool(() => 0, notices, false).execute('c', { action: 'play', target: 'tele' });
    await tool(undefined, notices).execute('c', { action: 'play', target: 'tele' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(notices).toEqual([]);
  });
});

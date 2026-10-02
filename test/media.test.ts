import { describe, expect, it, vi } from 'vitest';
import { AudioRecall, agoLabel } from '../src/media/recall.js';
import { createMediaTool } from '../src/tools/media.js';
import { stripWakeWord } from '../src/voice/wake.js';

// Stubbed so a test run cannot append to the real daily log under the state dir.
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/** Epoch ms chosen so "ago" arithmetic in the assertions is readable. */
const T0 = 1_700_000_000_000;
const CHAT = 'telegram:personal:8258546109';

function clock(start = T0): { now: () => number; advance: (ms: number) => void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

/** The tool hands back a union of text and image blocks; only the text matters here. */
function textOf(result: { content: Array<{ type: string; text?: string } | unknown> }): string {
  return (result.content as Array<{ text?: string }>).map((c) => c?.text ?? '').join('\n');
}

describe('AudioRecall', () => {
  it('returns the newest audio and nothing when the chat is empty', () => {
    const { now } = clock();
    const recall = new AudioRecall({ now });
    expect(recall.last(CHAT)).toBeNull();
    expect(recall.list(CHAT)).toEqual([]);

    recall.record(CHAT, { fileId: 'a1', mimeType: 'audio/ogg', messageId: 'm1', at: T0 });
    recall.record(CHAT, { fileId: 'a2', mimeType: 'audio/ogg', messageId: 'm2', at: T0 + 10 });
    expect(recall.last(CHAT)?.fileId).toBe('a2');
    expect(recall.size).toBe(2);
  });

  it('keeps chats separate, so one person\'s "the last audio" is not another\'s', () => {
    const { now } = clock();
    const recall = new AudioRecall({ now });
    const other = `${CHAT}#other`;
    recall.record(CHAT, { fileId: 'mine', mimeType: 'audio/ogg', messageId: 'm1', at: T0 });
    recall.record(other, { fileId: 'theirs', mimeType: 'audio/ogg', messageId: 'm1', at: T0 });

    expect(recall.last(CHAT)?.fileId).toBe('mine');
    expect(recall.last(other)?.fileId).toBe('theirs');
    expect(recall.chats).toBe(2);
  });

  it('prefers the audio on the message being answered over the previous one', () => {
    const { now } = clock();
    const recall = new AudioRecall({ now });
    recall.record(CHAT, { fileId: 'older', mimeType: 'audio/ogg', messageId: 'm1', at: T0 });
    recall.record(CHAT, { fileId: 'newer', mimeType: 'audio/ogg', messageId: 'm2', at: T0 + 1 });

    // The case that was broken: audio on one message, "/play" on the next.
    expect(recall.resolve(CHAT, { own: 'm2' })?.fileId).toBe('newer');
    // Replied to the older one explicitly, so that one wins even though it is not last.
    expect(recall.resolve(CHAT, { replyTo: 'm1' })?.fileId).toBe('older');
    // Neither: whatever arrived last.
    expect(recall.resolve(CHAT)?.fileId).toBe('newer');
  });

  it('is idempotent under Telegram redelivery and keeps the transcript it learned', () => {
    const { now } = clock();
    const recall = new AudioRecall({ now });
    recall.record(CHAT, { fileId: 'a1', mimeType: 'audio/ogg', messageId: 'm1', at: T0 });
    recall.setTranscript(CHAT, 'm1', 'pon algo de jazz');
    recall.record(CHAT, { fileId: 'a1', mimeType: 'audio/ogg', messageId: 'm1', at: T0 + 5 });

    expect(recall.size).toBe(1);
    expect(recall.last(CHAT)?.transcript).toBe('pon algo de jazz');
  });

  it('forgets on a TTL and caps per chat', () => {
    const t = clock();
    const recall = new AudioRecall({ now: t.now, ttlMs: 1000, perChat: 3 });
    for (let i = 0; i < 5; i++) {
      recall.record(CHAT, {
        fileId: `a${i}`,
        mimeType: 'audio/ogg',
        messageId: `m${i}`,
        at: T0 + i,
      });
    }
    expect(recall.size).toBe(3);
    expect(recall.last(CHAT)?.fileId).toBe('a4');
    expect(recall.list(CHAT).map((a) => a.fileId)).toEqual(['a4', 'a3', 'a2']);

    t.advance(10_000);
    expect(recall.last(CHAT)).toBeNull();
    expect(recall.size).toBe(0);
    // The chat is dropped entirely, so a long-lived daemon does not keep a list per
    // chat it has ever seen.
    expect(recall.chats).toBe(0);
  });

  it('describes age in the terms the user reads', () => {
    expect(agoLabel(T0, T0)).toBe('ahora mismo');
    expect(agoLabel(T0, T0 + 5 * 60_000)).toBe('hace 5 min');
    expect(agoLabel(T0, T0 + 3 * 3_600_000)).toBe('hace 3 h');
  });
});

describe('stripWakeWord', () => {
  it('leaves the instruction and drops the address', () => {
    expect(stripWakeWord('Asistenta, pon algo de jazz', 'asistenta')).toBe('pon algo de jazz');
    expect(stripWakeWord('asistenta abre YouTube', 'asistenta')).toBe('abre YouTube');
    expect(stripWakeWord('¿Asistenta? qué hora es.', 'asistenta')).toBe('qué hora es');
  });

  it('keeps what came after a second address', () => {
    // "asisten" is the two-character truncation the matcher accepts at the default
    // sensitivity, so it counts as an address and only that one is dropped.
    expect(stripWakeWord('Asistenta, pon X, y luego asisten para', 'asistenta')).toBe('para');
    // A one-character slip is not an address at the default sensitivity, so the
    // leading one is removed and the rest of the sentence survives intact.
    expect(stripWakeWord('Asistenta, pon X, y luego Asistena para', 'asistenta')).toBe(
      'pon X y luego Asistena para',
    );
  });

  it('passes the sentence through when no address is in it', () => {
    expect(stripWakeWord('pon algo de jazz', 'asistenta')).toBe('pon algo de jazz');
    expect(stripWakeWord('', 'asistenta')).toBe('');
  });

  it('works on a multi-word wake phrase', () => {
    expect(stripWakeWord('oye asistente, mira la camara', 'oye asistente')).toBe('mira la camara');
  });
});

describe('createMediaTool', () => {
  const deps = (overrides: Partial<Parameters<typeof createMediaTool>[0]> = {}) => {
    const { now } = clock();
    const recall = new AudioRecall({ now });
    return {
      tool: createMediaTool({
        chatKey: CHAT,
        recall,
        downloadAudio: async () => null,
        chatId: '8258546109',
        maxEdge: 1280,
        sendPhoto: async () => '1',
        sendVideo: async () => true,
        sendVoice: async () => true,
        ...overrides,
      }),
      recall,
    };
  };

  it('says what it has rather than inventing one', async () => {
    const { tool } = deps();
    const result = await tool.execute('c1', { action: 'list_audio' });
    expect(textOf(result)).toContain('No tengo audios');
    expect(result.details).toMatchObject({ count: 0 });
  });

  it('refuses to play when nothing was ever sent, and says so plainly', async () => {
    const { tool } = deps();
    const result = await tool.execute('c2', { action: 'play' });
    expect(result.details).toMatchObject({ played: false, reason: 'nothing remembered' });
    expect(textOf(result)).toMatch(/Mándame uno/);
  });

  it('does not download anything when there is nothing to download', async () => {
    const downloadAudio = vi.fn(async () => Buffer.alloc(4));
    const { tool } = deps({ downloadAudio });
    await tool.execute('c3', { action: 'play' });
    expect(downloadAudio).not.toHaveBeenCalled();
  });

  it('lists what it can play, newest first, with the transcript it has', async () => {
    const { tool, recall } = deps();
    // Recorded oldest first, the way they arrive: `at` comes from the clock inside
    // `record`, so arrival order and age order are the same thing in practice.
    recall.record(CHAT, {
      fileId: 'old',
      mimeType: 'audio/ogg',
      messageId: 'm3',
      at: T0 - 1_500_000,
    });
    recall.record(CHAT, {
      fileId: 'middle',
      mimeType: 'audio/ogg',
      messageId: 'm1',
      at: T0 - 60_000,
      durationSeconds: 4,
    });
    recall.setTranscript(CHAT, 'm1', 'hola que tal');
    recall.record(CHAT, {
      fileId: 'new',
      mimeType: 'audio/ogg',
      messageId: 'm2',
      at: T0 - 5_000,
    });

    const text = textOf(await tool.execute('c4', { action: 'list_audio' }));
    expect(text).toContain('(3)');
    // Newest first, so the "1." the model would quote by number is the latest.
    const lines = text.split('\n').slice(1);
    expect(lines[0]).toMatch(/^1\..*ahora mismo/);
    expect(lines[1]).toContain('hace 1 min');
    expect(lines[1]).toContain('hola que tal');
    expect(lines[1]).toContain('4s');
    expect(lines[2]).toContain('hace 25 min');
    expect(lines[2]).toContain('duracion desconocida');
  });

  it('reports a live view as unavailable rather than pretending', async () => {
    const { tool } = deps();
    const result = await tool.execute('c6', { action: 'live_view', source: 'camera' });
    expect(textOf(result)).toMatch(/no está disponible/);
  });

  it('passes the source and interval through to the live view', async () => {
    const start = vi.fn(async () => 'Camara en directo.');
    const stop = vi.fn(async () => 'parada');
    const { tool } = deps({ live: { start, stop } });
    await tool.execute('c7', { action: 'live_view', source: 'camera', intervalSeconds: 3 });
    expect(start).toHaveBeenCalledWith('camera', 3);

    await tool.execute('c8', { action: 'live_view', source: 'off' });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('returns whatever the live view said when it is turned off', async () => {
    const stop = vi.fn(async () => 'No hay ninguna vista en directo activa.');
    const { tool } = deps({ live: { start: vi.fn(async () => ''), stop } });
    const result = await tool.execute('c10', { action: 'live_view', source: 'off' });
    expect(stop).toHaveBeenCalledOnce();
    expect(textOf(result)).toMatch(/no hay ninguna vista/i);
  });
});

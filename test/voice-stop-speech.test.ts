import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { stopSpokenReply } from '../src/voice/stop-speech.js';

// /stop en Telegram mientras el PC lee en voz alta la respuesta de la conversación por
// voz: antes /stop paraba el turno y la cola de /altavoz, pero la voz seguía sonando.
describe('/stop corta la respuesta hablada de la conversación por voz', () => {
  it('mismo chat: corta la voz y el audio que suena, y cuenta 1', () => {
    const speech = { abort: vi.fn() };
    const playback = { stop: vi.fn() };
    const n = stopSpokenReply({
      chatKey: 'telegram:personal:1',
      sessionChatKey: 'telegram:personal:1',
      speech,
      playback,
    });
    expect(n).toBe(1);
    expect(speech.abort).toHaveBeenCalledTimes(1);
    expect(playback.stop).toHaveBeenCalledTimes(1);
  });

  it('otro chat: no toca la voz de esa conversación', () => {
    const speech = { abort: vi.fn() };
    const playback = { stop: vi.fn() };
    const n = stopSpokenReply({
      chatKey: 'telegram:personal:2',
      sessionChatKey: 'telegram:personal:1',
      speech,
      playback,
    });
    expect(n).toBe(0);
    expect(speech.abort).not.toHaveBeenCalled();
    expect(playback.stop).not.toHaveBeenCalled();
  });

  it('sin voz sonando o sin conversación abierta: nada que cortar', () => {
    expect(stopSpokenReply({ chatKey: 'a', sessionChatKey: 'a', speech: null })).toBe(0);
    const speech = { abort: vi.fn() };
    expect(stopSpokenReply({ chatKey: 'a', sessionChatKey: null, speech })).toBe(0);
    expect(speech.abort).not.toHaveBeenCalled();
  });

  it('un fallo al cortar no rompe /stop', () => {
    const speech = {
      abort: () => {
        throw new Error('x');
      },
    };
    const playback = { stop: vi.fn() };
    expect(stopSpokenReply({ chatKey: 'a', sessionChatKey: 'a', speech, playback })).toBe(1);
    expect(playback.stop).toHaveBeenCalledTimes(1);
  });

  it('cmdStop del daemon lo usa con el chat de la conversación abierta', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const start = src.indexOf('const cmdStop = async');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('\n  };', start));
    expect(body).toContain('stopSpokenReply(');
    expect(body).toContain('sessionChatKey');
    expect(src).toContain('sessionChatKey = chat.key;');
  });
});

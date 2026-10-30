import { describe, expect, it } from 'vitest';
import { chatIdOf, chatKey, chatNumberOf, parseChatKey } from '../src/channels/types.js';

describe('chat key helpers', () => {
  it('parseChatKey returns the pieces chatKey joined', () => {
    const key = chatKey({ channel: 'telegram', account: 'bot1', chatId: '-100123', threadId: '7' });
    expect(parseChatKey(key)).toEqual({
      channel: 'telegram',
      account: 'bot1',
      chatId: '-100123',
      threadId: '7',
    });
    expect(parseChatKey('telegram:bot1:42').threadId).toBeUndefined();
  });

  it('chatIdOf gives the chat id, with or without a topic', () => {
    expect(chatIdOf('telegram:bot1:42')).toBe('42');
    expect(chatIdOf('telegram:bot1:-100123:7')).toBe('-100123');
  });

  it("chatIdOf gives '' when the key has no chat id, as split(':')[2] ?? '' did", () => {
    expect(chatIdOf('telegram:bot1')).toBe('');
    expect(chatIdOf('')).toBe('');
  });

  it('chatNumberOf is Number() of the chat id, NaN when missing (as before)', () => {
    expect(chatNumberOf('telegram:bot1:-100123:7')).toBe(-100123);
    expect(chatNumberOf('telegram:bot1')).toBeNaN();
  });
});

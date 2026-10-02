import { describe, expect, it } from 'vitest';
import { chatKey } from '../src/channels/types.js';
import { safeEqual } from '../src/permissions.js';
import { normalizeAction } from '../src/tools/computer.js';

describe('normalizeAction', () => {
  it('recovers a leaked MiniMax tool call', () => {
    // space-bunny-free emits roughly a quarter of its tool calls into the text
    // channel instead of tool_calls. If this regresses, steps silently vanish.
    const text =
      'Clicking at approximately (113, 175):\n<|minimax|><|tool_call|> {"name":"computer","arguments":{"action":"click","x":113,"y":175}} </|tool_call|>';
    expect(normalizeAction(text)).toEqual({
      action: 'click',
      x: 113,
      y: 175,
      button: 'left',
      clicks: 1,
    });
  });

  it('parses plain JSON too', () => {
    expect(normalizeAction('{"action":"screenshot"}')).toEqual({ action: 'screenshot' });
  });

  it('handles every action in the union', () => {
    expect(normalizeAction('{"action":"type","text":"hola"}')).toEqual({
      action: 'type',
      text: 'hola',
    });
    expect(normalizeAction('{"action":"key","key":"enter"}')).toEqual({
      action: 'key',
      key: 'enter',
    });
    expect(normalizeAction('{"action":"move","x":1,"y":2}')).toEqual({
      action: 'move',
      x: 1,
      y: 2,
    });
    expect(normalizeAction('{"action":"drag","x":1,"y":2,"toX":3,"toY":4}')).toEqual({
      action: 'drag',
      x: 1,
      y: 2,
      toX: 3,
      toY: 4,
    });
  });

  it('returns null rather than guessing', () => {
    expect(normalizeAction('I will take a screenshot now')).toBeNull();
    expect(normalizeAction('not json {oops')).toBeNull();
    expect(normalizeAction('')).toBeNull();
    expect(normalizeAction('{"action":"selfdestruct"}')).toBeNull();
  });
});

describe('safeEqual', () => {
  it('compares equal and unequal strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('chatKey', () => {
  it('includes the thread when there is one', () => {
    expect(chatKey({ channel: 'telegram', account: 'main', chatId: '42' })).toBe(
      'telegram:main:42',
    );
    expect(chatKey({ channel: 'telegram', account: 'main', chatId: '42', threadId: '7' })).toBe(
      'telegram:main:42:7',
    );
  });
});

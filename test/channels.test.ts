import { describe, expect, it } from 'vitest';
import { ChannelRegistry } from '../src/channels/registry.js';
import { chunkText, isAddressedToBot, isStopCommand } from '../src/channels/telegram.js';
import {
  type ChannelAdapter,
  type ChannelHandlers,
  chatKey,
  type Outbound,
} from '../src/channels/types.js';

interface FakeAdapter extends ChannelAdapter {
  sent: Outbound[];
  handlers: ChannelHandlers | null;
}

function fakeAdapter(name: string, ready = true): FakeAdapter {
  const sent: Outbound[] = [];
  const self: FakeAdapter = {
    name,
    account: 'main',
    sent,
    handlers: null,
    isReady: () => ready,
    async start(handlers: ChannelHandlers) {
      self.handlers = handlers;
    },
    async send(o: Outbound) {
      sent.push(o);
      return `msg-${sent.length}`;
    },
    async stop() {},
  };
  return self;
}

describe('chunkText', () => {
  it('leaves short text alone', () => {
    expect(chunkText('hola', 4000)).toEqual(['hola']);
  });

  it('splits long text without losing characters', () => {
    const long = 'a'.repeat(9500);
    const parts = chunkText(long, 4000);
    expect(parts).toHaveLength(3);
    expect(parts.join('')).toBe(long);
  });

  it('respects an exact boundary', () => {
    expect(chunkText('abcd', 4)).toEqual(['abcd']);
    expect(chunkText('abcde', 4)).toEqual(['abcd', 'e']);
  });

  it('never splits a surrogate pair', () => {
    // Slicing 'a😀b' at UTF-16 offset 2 leaves a lone surrogate; Array.from keeps
    // the emoji whole so the user sees 😀 instead of �.
    expect(chunkText('a😀b', 2)).toEqual(['a😀', 'b']);
  });
});

describe('isStopCommand', () => {
  it('matches /stop with suffixes and trailing text', () => {
    expect(isStopCommand('/stop')).toBe(true);
    expect(isStopCommand('/stop now please')).toBe(true);
    expect(isStopCommand('/stop@asistenta_personal_bot')).toBe(true);
    expect(isStopCommand('  /stop  ')).toBe(true);
  });

  it('rejects lookalikes', () => {
    expect(isStopCommand('/stopwatch')).toBe(false);
    expect(isStopCommand('stop')).toBe(false);
    expect(isStopCommand('/start')).toBe(false);
  });
});

describe('isAddressedToBot', () => {
  it('matches mentions and replies to the bot', () => {
    expect(isAddressedToBot('hey @asistenta_personal_bot do x', {}, 'asistenta_personal_bot')).toBe(
      true,
    );
    expect(
      isAddressedToBot(
        'thanks',
        { reply_to_message: { from: { is_bot: true } } },
        'asistenta_personal_bot',
      ),
    ).toBe(true);
  });

  it('ignores everything else', () => {
    expect(isAddressedToBot('hey @someoneelse do x', {}, 'asistenta_personal_bot')).toBe(false);
    expect(isAddressedToBot('just chatting', {}, 'asistenta_personal_bot')).toBe(false);
    expect(
      isAddressedToBot(
        'reply',
        { reply_to_message: { from: { is_bot: false } } },
        'asistenta_personal_bot',
      ),
    ).toBe(false);
  });
});

describe('ChannelRegistry', () => {
  it('refuses two adapters on the same channel and account', () => {
    const registry = new ChannelRegistry();
    registry.register(fakeAdapter('telegram'));
    expect(() => registry.register(fakeAdapter('telegram'))).toThrow(/already registered/);
  });

  it('allows different accounts on the same channel', () => {
    const registry = new ChannelRegistry();
    registry.register(fakeAdapter('telegram'));
    const other = { ...fakeAdapter('telegram'), account: 'second' };
    registry.register(other as ChannelAdapter);
    expect(registry.all()).toHaveLength(2);
  });

  it('starts every adapter with wired handlers', async () => {
    const registry = new ChannelRegistry();
    const a = fakeAdapter('telegram');
    registry.register(a);
    const seen: string[] = [];
    await registry.startAll({
      onMessage: (i) => {
        seen.push(i.text);
      },
      log: () => {},
    });
    await a.handlers?.onMessage({
      channel: 'telegram',
      account: 'main',
      chatId: '1',
      userId: '2',
      text: 'hola',
      authorised: true,
      messageId: '3',
      receivedAt: new Date().toISOString(),
    });
    expect(seen).toEqual(['hola']);
  });

  it('only broadcasts to adapters that are ready', async () => {
    const registry = new ChannelRegistry();
    const ready = fakeAdapter('telegram', true);
    const notReady = { ...fakeAdapter('telegram', false), account: 'down' } as ChannelAdapter;
    registry.register(ready);
    registry.register(notReady);

    await registry.broadcast({ channel: 'telegram', chatId: '1', text: 'hi' });
    expect(ready.sent).toHaveLength(1);
  });

  it('resolves an approval and forgets it afterwards', async () => {
    const registry = new ChannelRegistry();
    registry.register(fakeAdapter('telegram'));
    await registry.startAll({ onMessage: () => {}, log: () => {} });

    const promise = registry.requestApproval({
      id: 'req-1',
      origin: {
        channel: 'telegram',
        account: 'main',
        chatId: '1',
        userId: '2',
        text: '',
        authorised: true,
        messageId: '3',
        receivedAt: new Date().toISOString(),
      },
      tool: 'computer',
      reason: 'drives the desktop',
      summary: 'click at 10,10',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(registry.pendingApprovals()).toHaveLength(1);
    expect(registry.resolveApproval('req-1', true)).toBe(true);
    expect(await promise).toBe(true);
    expect(registry.pendingApprovals()).toHaveLength(0);
  });

  it('treats an expired approval as refused', async () => {
    const registry = new ChannelRegistry();
    registry.register(fakeAdapter('telegram'));
    await registry.startAll({ onMessage: () => {}, log: () => {} });

    const promise = registry.requestApproval({
      id: 'req-2',
      origin: {
        channel: 'telegram',
        account: 'main',
        chatId: '1',
        userId: '2',
        text: '',
        authorised: true,
        messageId: '3',
        receivedAt: new Date().toISOString(),
      },
      tool: 'shell',
      reason: 'destructive',
      summary: 'rm -rf',
      expiresAt: new Date(Date.now() - 1).toISOString(),
    });

    expect(await promise).toBe(false);
  });

  it('ignores a resolution for an unknown id', () => {
    const registry = new ChannelRegistry();
    expect(registry.resolveApproval('nope', true)).toBe(false);
  });
});

describe('chatKey', () => {
  it('keys state per chat so approvals do not leak across chats', () => {
    const a = chatKey({ channel: 'telegram', account: 'main', chatId: '100' });
    const b = chatKey({ channel: 'telegram', account: 'main', chatId: '200' });
    expect(a).not.toBe(b);
  });
});

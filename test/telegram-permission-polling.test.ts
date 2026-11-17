import type { Update } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  deliver: undefined as undefined | ((updates: Update[]) => Promise<void>),
  apiCalls: [] as string[],
  stop: undefined as undefined | (() => void),
}));

// Keep grammY's real middleware and sequential handleUpdates loop. Only the
// network and long-poll transport are replaced; no Telegram account is used.
vi.mock('grammy', async (original) => {
  const real = await original<typeof import('grammy')>();
  class Bot extends real.Bot {
    constructor(token: string) {
      super(token, {
        botInfo: {
          id: 99,
          is_bot: true,
          first_name: 'Test',
          username: 'test_bot',
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
          can_connect_to_business: false,
          has_main_web_app: false,
          has_topics_enabled: false,
          allows_users_to_create_topics: false,
          can_manage_bots: false,
          supports_join_request_queries: false,
        },
        client: {
          fetch: (async (url: string) => {
            harness.apiCalls.push(String(url).split('/').pop() ?? '');
            return { json: async () => ({ ok: true, result: true }) };
          }) as never,
        },
      });
    }
    override async start(): Promise<void> {
      harness.deliver = (updates) =>
        (this as unknown as { handleUpdates(updates: Update[]): Promise<void> }).handleUpdates(
          updates,
        );
      await new Promise<void>((resolve) => {
        harness.stop = resolve;
      });
    }
    override async stop(): Promise<void> {
      harness.stop?.();
    }
  }
  return { ...real, Bot };
});

import { TelegramChannel } from '../src/channels/telegram.js';

const message = (id: number, text: string): Update => ({
  update_id: id,
  message: {
    message_id: id,
    date: Math.floor(Date.now() / 1000),
    text,
    chat: { id: 42, type: 'private', first_name: 'Owner' },
    from: { id: 7, is_bot: false, first_name: 'Owner' },
  },
});
const press = (data: string, userId = 7, chatId = 42): Update => ({
  update_id: 20,
  callback_query: {
    id: 'callback',
    data,
    chat_instance: 'instance',
    from: { id: userId, is_bot: false, first_name: 'Owner' },
    message: {
      message_id: 100,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Owner' },
    },
  },
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

let currentChannel: TelegramChannel | undefined;
afterEach(async () => {
  await currentChannel?.stop();
  currentChannel = undefined;
  harness.deliver = undefined;
  harness.apiCalls.length = 0;
  vi.restoreAllMocks();
});

describe('Telegram polling stays available during a permission wait', () => {
  it.each(['approve:once:', 'approve:session:', 'approve:always:', 'deny:'])(
    'reads %s while the inbound handler is still waiting',
    async (prefix) => {
      const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
      currentChannel = channel;
      vi.spyOn(channel, 'send').mockResolvedValue('100');
      let choice: unknown;
      const onMessage = vi.fn(async () => {
        choice = await channel.offerApproval('pending', '42', 'Permission?', { askScope: true });
      });
      await channel.start({ onMessage, log: vi.fn() });
      let readNextBatch = false;
      const polling = (async () => {
        await harness.deliver?.([message(1, '/reintentar')]);
        readNextBatch = true;
        await harness.deliver?.([press(`${prefix}pending`)]);
      })();
      await tick();
      // Before the fix this is false: grammY is waiting for the permission
      // inside onMessage and cannot fetch or process its callback.
      expect(readNextBatch).toBe(true);
      await polling;
      await tick();
      expect(onMessage).toHaveBeenCalledOnce();
      expect(choice).toEqual({
        approved: prefix !== 'deny:',
        scope:
          prefix === 'approve:session:'
            ? 'session'
            : prefix === 'approve:always:'
              ? 'always'
              : 'once',
      });
      expect(harness.apiCalls).toContain('answerCallbackQuery');
      channel.cancelApprovals();
    },
  );

  it('still rejects another sender, another chat, stale and duplicate decisions', async () => {
    const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
    currentChannel = channel;
    vi.spyOn(channel, 'send').mockResolvedValue('100');
    const log = vi.fn();
    await channel.start({ onMessage: vi.fn(), log });
    let resolved = false;
    const waiting = channel.offerApproval('pending', '42', 'Permission?').then((v) => {
      resolved = true;
      return v;
    });
    for (const update of [
      press('approve:pending', 8),
      press('approve:pending', 7, 43),
      press('approve:missing'),
    ]) {
      await harness.deliver?.([update]);
      await tick();
      expect(resolved).toBe(false);
    }
    await harness.deliver?.([press('deny:pending'), press('approve:pending')]);
    await tick();
    await expect(waiting).resolves.toEqual({ approved: false, scope: 'once' });
  });

  it('accepts approval after a command button starts the waiting turn', async () => {
    const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
    currentChannel = channel;
    vi.spyOn(channel, 'send').mockResolvedValue('100');
    let choice: unknown;
    await channel.start({
      onMessage: async () => {
        choice = await channel.offerApproval('retry', '42', 'Permission?');
      },
      log: vi.fn(),
    });
    let firstBatchDone = false;
    const polling = (async () => {
      await harness.deliver?.([press('cmd:reintentar target')]);
      firstBatchDone = true;
      await harness.deliver?.([press('approve:retry')]);
    })();
    await tick();
    expect(firstBatchDone).toBe(true);
    await polling;
    await tick();
    expect(choice).toEqual({ approved: true, scope: 'once' });
  });

  it('receives /stop during a permission wait, without approving it', async () => {
    const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
    currentChannel = channel;
    vi.spyOn(channel, 'send').mockResolvedValue('100');
    let choice: unknown;
    const received: string[] = [];
    await channel.start({
      onMessage: async (inbound) => {
        received.push(inbound.text);
        if (inbound.text === '/stop') channel.cancelForChat(inbound.chatId);
        else choice = await channel.offerApproval('pending', '42', 'Permission?');
      },
      log: vi.fn(),
    });
    let firstBatchDone = false;
    const polling = (async () => {
      await harness.deliver?.([message(1, '/reintentar')]);
      firstBatchDone = true;
      await harness.deliver?.([message(2, '/stop')]);
    })();
    await tick();
    expect(firstBatchDone).toBe(true);
    await polling;
    await tick();
    expect(received).toEqual(['/reintentar', '/stop']);
    expect(choice).toEqual({ approved: false, scope: 'once' });
  });

  it('observes rejected handlers and continues receiving updates', async () => {
    const channel = new TelegramChannel({ token: 'test', allowedUserIds: [7] });
    currentChannel = channel;
    const log = vi.fn();
    const onMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('test failure'))
      .mockResolvedValue(undefined);
    await channel.start({ onMessage, log });
    await harness.deliver?.([message(1, 'first'), message(2, 'second')]);
    await tick();
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      'error',
      'telegram update failed',
      expect.objectContaining({ kind: 'message' }),
    );
  });
});

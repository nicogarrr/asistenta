import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
  type IdleClient,
  type IdleCursor,
  type IdleDeps,
  idleScope,
  MailIdleTransport,
  reconcileCursor,
} from '../src/mail/idle.js';
import type { MailAccount } from '../src/mail/types.js';

const account: MailAccount = {
  address: 'me@example.test',
  password: 'private',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
};
class Mock extends EventEmitter {
  capabilities = new Map<string, unknown>([['IDLE', true]]);
  box = { uidValidity: 1n, uidNext: 5, readOnly: true };
  connect = vi.fn(async () => {});
  mailboxOpen = vi.fn(async (_folder: string, _opts: { readOnly: true }) => ({ ...this.box }));
  search = vi.fn(async (_query: { uid: string }, _opts: { uid: true }) => [5]);
  fetchOne = vi.fn(async (uid: string, _query: unknown, _opts: { uid: true }) => ({
    uid: Number(uid),
    source: Buffer.from('Subject: ok\r\n\r\nPedido confirmado'),
    envelope: { subject: 'Pedido' },
    internalDate: new Date(),
    flags: new Set<string>(),
  }));
  private done: (() => void) | null = null;
  idle = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        this.done = () => resolve(true);
      }),
  );
  arrive(next: number) {
    this.box.uidNext = next;
    this.emit('exists');
    // Real IMAP IDLE may keep running after EXISTS; queued EXAMINE interrupts it.
  }
  close = vi.fn(() => {
    this.emit('close');
    this.done?.();
  });
}
const active: MailIdleTransport[] = [];
afterEach(async () => {
  for (const t of active.splice(0)) await t.stop();
  vi.useRealTimers();
});
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function setup(
  clients: Mock[],
  cursor: IdleCursor | null = null,
  overrides: Partial<IdleDeps> = {},
) {
  const saved = { v: cursor };
  const deliver = vi.fn(async (_messages: unknown[]) => {});
  const factory = vi.fn(() => clients.shift() as unknown as IdleClient);
  const status = vi.fn();
  const deps: IdleDeps = {
    account: async () => account,
    load: () => saved.v,
    save: (_s, c) => {
      saved.v = c;
    },
    deliver,
    factory,
    status,
    ...overrides,
  };
  const t = new MailIdleTransport(deps);
  active.push(t);
  t.start();
  return { t, saved, deliver, factory, status };
}
it('baselines initial mailbox, then fetches only arrival UIDs with read-only and bounded PEEK source', async () => {
  const c = new Mock();
  const s = setup([c]);
  await tick();
  expect(c.search).not.toHaveBeenCalled();
  expect(s.saved.v).toEqual({ validity: '1', next: 5 });
  c.arrive(6);
  await tick();
  expect(c.mailboxOpen).toHaveBeenCalledWith('INBOX', { readOnly: true });
  expect(c.search).toHaveBeenCalledWith({ uid: '5:5' }, { uid: true });
  expect(c.fetchOne).toHaveBeenCalledWith(
    '5',
    expect.objectContaining({ source: { maxLength: 32768 } }),
    { uid: true },
  );
  expect(s.deliver).toHaveBeenCalledOnce();
  expect(s.saved.v?.next).toBe(6);
});
it('reconnect catches a missed UID despite unchanged EXISTS, never replays delivered UID', async () => {
  vi.useFakeTimers();
  const a = new Mock();
  const b = new Mock();
  b.box.uidNext = 7;
  b.search.mockResolvedValue([6]);
  const s = setup([a, b], { validity: '1', next: 5 });
  await tick();
  a.arrive(6);
  await tick();
  a.close();
  await tick();
  await vi.advanceTimersByTimeAsync(30000);
  await tick();
  expect(b.search).toHaveBeenCalledWith({ uid: '6:6' }, { uid: true });
  expect(s.saved.v?.next).toBe(7);
  expect(s.deliver).toHaveBeenCalledTimes(2);
});
it('UIDVALIDITY change rebases rather than treating old UID as new mail', async () => {
  vi.useFakeTimers();
  const a = new Mock();
  const b = new Mock();
  b.box = { uidValidity: 2n, uidNext: 100, readOnly: true };
  const s = setup([a, b], { validity: '1', next: 5 });
  await tick();
  a.close();
  await tick();
  await vi.advanceTimersByTimeAsync(30000);
  await tick();
  expect(b.search).not.toHaveBeenCalled();
  expect(s.saved.v).toEqual({ validity: '2', next: 100 });
});
it('delivery failure leaves UID pending for reconnect', async () => {
  const c = new Mock();
  const s = setup([c], null, {
    deliver: async () => {
      throw new Error('storage failed');
    },
  });
  await tick();
  c.arrive(6);
  await tick();
  expect(s.saved.v?.next).toBe(5);
  expect(c.close).toHaveBeenCalled();
});
it('no IDLE capability never enters library polling fallback', async () => {
  const c = new Mock();
  c.capabilities.clear();
  const s = setup([c]);
  await tick();
  expect(c.idle).not.toHaveBeenCalled();
  expect(c.mailboxOpen).not.toHaveBeenCalled();
  expect(s.status).toHaveBeenCalledWith('unsupported');
});
it('read-write mailbox response fails closed before fetch', async () => {
  const c = new Mock();
  c.box.readOnly = false;
  const s = setup([c]);
  await tick();
  expect(c.fetchOne).not.toHaveBeenCalled();
  expect(s.deliver).not.toHaveBeenCalled();
});
it('stop interrupts active IDLE, cancels retries and never reconnects', async () => {
  vi.useFakeTimers();
  const c = new Mock();
  const s = setup([c]);
  await tick();
  await s.t.stop();
  await vi.advanceTimersByTimeAsync(3600000);
  expect(s.factory).toHaveBeenCalledTimes(1);
  expect(c.close).toHaveBeenCalled();
});
it('broken immediate IDLE uses backoff rather than spinning', async () => {
  vi.useFakeTimers();
  const c = new Mock();
  c.idle.mockImplementation(async () => true);
  const s = setup([c]);
  await tick();
  expect(s.factory).toHaveBeenCalledTimes(1);
  expect(s.status).toHaveBeenCalledWith('retrying');
  await vi.advanceTimersByTimeAsync(10000);
  expect(s.factory).toHaveBeenCalledTimes(1);
});
it('scope separates accounts, endpoints and UIDVALIDITY reconciles corrupt state', () => {
  expect(idleScope(account)).not.toBe(idleScope({ ...account, address: 'other@example.test' }));
  expect(idleScope(account)).not.toContain('example');
  expect(reconcileCursor({ validity: '1', next: 99 }, { uidValidity: 1n, uidNext: 5 })).toEqual({
    validity: '1',
    next: 5,
  });
  expect(() => reconcileCursor(null, { uidValidity: 1n, uidNext: NaN })).toThrow();
});
it('UIDVALIDITY reset during same connection is rechecked before fetching', async () => {
  const c = new Mock();
  const s = setup([c]);
  await tick();
  c.box.uidValidity = 9n;
  c.arrive(50);
  await tick();
  expect(c.fetchOne).not.toHaveBeenCalled();
  expect(s.saved.v).toEqual({ validity: '9', next: 50 });
});
it('burst reads bounded UID chunks and ignores server UIDs outside requested range', async () => {
  const c = new Mock();
  const s = setup([c]);
  await tick();
  c.search
    .mockResolvedValueOnce([4, ...Array.from({ length: 30 }, (_, i) => i + 5), 999])
    .mockResolvedValueOnce([30, 31, 32, 33, 34]);
  c.arrive(35);
  for (let i = 0; i < 20; i++) await tick();
  expect(s.deliver).toHaveBeenCalledTimes(30);
  expect(s.saved.v?.next).toBe(35);
  expect(c.fetchOne).not.toHaveBeenCalledWith('4', expect.anything(), expect.anything());
  expect(c.fetchOne).not.toHaveBeenCalledWith('999', expect.anything(), expect.anything());
});
it('hung connect is aborted on shutdown without waiting for network timeout', async () => {
  const c = new Mock();
  c.connect.mockImplementation(() => new Promise<void>(() => {}));
  const s = setup([c]);
  await tick();
  await s.t.stop();
  expect(c.close).toHaveBeenCalled();
  expect(c.mailboxOpen).not.toHaveBeenCalled();
});
it('UID mismatch never accepts data or advances cursor', async () => {
  const c = new Mock();
  const s = setup([c]);
  await tick();
  c.fetchOne.mockImplementation(async () => ({
    uid: 999,
    source: Buffer.from('bad'),
    envelope: { subject: 'bad' },
    internalDate: new Date(),
    flags: new Set<string>(),
  }));
  c.arrive(6);
  await tick();
  expect(s.saved.v?.next).toBe(5);
  expect(s.deliver).not.toHaveBeenCalled();
});
it('disconnect during a burst never advances past undelivered UIDs', async () => {
  const c = new Mock();
  const s = setup([c]);
  await tick();
  c.search.mockResolvedValue([5, 6, 7]);
  c.fetchOne.mockImplementation(async (uid) => {
    c.close();
    return {
      uid: Number(uid),
      source: Buffer.from('hello'),
      envelope: { subject: 'hello' },
      internalDate: new Date(),
      flags: new Set<string>(),
    };
  });
  c.arrive(8);
  await tick();
  expect(s.saved.v?.next).toBeLessThan(8);
  expect(c.fetchOne).toHaveBeenCalledTimes(1);
});

it('una conexión sana que acaba en error no alarga la espera de reconexión', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const delays: number[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if ((ms ?? 0) >= 30_000) delays.push(ms ?? 0);
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);
  let clock = 1_000_000;
  const clients = [new Mock(), new Mock(), new Mock()];
  for (const c of clients) {
    let opens = 0;
    // El segundo EXAMINE (el de ponerse al día) llega 2 h después: conexión sana.
    c.mailboxOpen = vi.fn(async () => {
      if (++opens === 2) clock += 2 * 60 * 60_000;
      return { ...c.box };
    });
    // Y luego el IDLE se corta enseguida: termina en excepción («IDLE ended early»).
    c.idle = vi.fn(async () => true);
  }
  setup(clients, null, { now: () => clock });
  for (let i = 0; i < 3; i++) {
    await tick();
    await vi.advanceTimersByTimeAsync(delays[delays.length - 1] ?? 30_000);
  }
  spy.mockRestore();
  expect(delays.slice(0, 3)).toEqual([30_000, 30_000, 30_000]);
});

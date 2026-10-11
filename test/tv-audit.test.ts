import { expect, it } from 'vitest';
import { pairTv, type TvSocket, tvRequest } from '../src/tv/lgtv.js';

class Socket implements TvSocket {
  onceMap = new Map<string, (...a: unknown[]) => void>();
  msgs: ((x: unknown) => void)[] = [];
  sent: string[] = [];
  closed = false;

  constructor(fail = false) {
    queueMicrotask(() => this.onceMap.get(fail ? 'error' : 'open')?.(new Error('mock fail')));
  }

  once(e: string, f: (...a: unknown[]) => void): void {
    this.onceMap.set(e, f);
  }

  on(e: string, f: (x: unknown) => void): void {
    if (e === 'message') this.msgs.push(f);
  }

  send(x: string): void {
    this.sent.push(x);
  }

  close(): void {
    this.closed = true;
  }

  emit(x: unknown): void {
    for (const f of this.msgs) f(JSON.stringify(x));
  }
}

const tick = () => new Promise((r) => setImmediate(r));

it('closes failed first socket before fallback', async () => {
  const sockets: Socket[] = [];
  const p = pairTv('192.168.1.237', {
    allowPlaintext: true, // el downgrade se pide explicito; este test ejercita el fallback
    factory: () => {
      const s = new Socket(sockets.length === 0);
      sockets.push(s);
      return s;
    },
  });
  await tick();
  sockets[1]?.emit({ type: 'registered', id: 'register_0', payload: { 'client-key': 'fake' } });
  await p;
  expect(sockets[0]?.closed).toBe(true);
});

it('returnValue false is rejected', async () => {
  let s: Socket | undefined;
  const p = tvRequest(
    '192.168.1.237',
    'fake',
    'system/turnOff',
    {},
    {
      factory: () => {
        s = new Socket();
        return s;
      },
    },
  );
  await tick();
  s?.emit({ type: 'registered', id: 'register_0', payload: { 'client-key': 'fake' } });
  await tick();
  const req = JSON.parse(s?.sent.at(-1) ?? 'null') as { id: string };
  s?.emit({
    type: 'response',
    id: req.id,
    payload: { returnValue: false, errorText: 'not permitted' },
  });
  await expect(p).rejects.toThrow();
});

it('wrong registration id is not accepted', async () => {
  let s: Socket | undefined;
  const p = pairTv('192.168.1.237', {
    pairTimeoutMs: 15,
    factory: () => {
      s = new Socket();
      return s;
    },
  });
  await tick();
  s?.emit({ type: 'registered', id: 'unrelated', payload: { 'client-key': 'wrong' } });
  await expect(p).rejects.toThrow();
});

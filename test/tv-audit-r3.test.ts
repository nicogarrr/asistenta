import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import { pairTv, type TvSocket, tvRequest } from '../src/tv/lgtv.js';

class Socket extends EventEmitter {
  sent: string[] = [];

  constructor() {
    super();
    queueMicrotask(() => this.emit('open'));
  }

  send(x: string): void {
    this.sent.push(x);
  }

  close(): void {
    this.emit('close');
  }
}

const tick = () => new Promise((r) => setImmediate(r));

it('numeric external error does not throw outside promise', async () => {
  let s: Socket | undefined;
  const p = pairTv('192.168.1.237', {
    pairTimeoutMs: 20,
    factory: () => {
      s = new Socket();
      return s as unknown as TvSocket;
    },
  });
  const settled = p.catch(() => {});
  await tick();
  expect(() =>
    s?.emit('message', JSON.stringify({ id: 'register_0', type: 'error', error: 123 })),
  ).not.toThrow();
  await settled;
});

it('malformed response does not announce successful command', async () => {
  let s: Socket | undefined;
  const p = tvRequest(
    '192.168.1.237',
    'fake',
    'system/turnOff',
    {},
    {
      commandTimeoutMs: 20,
      factory: () => {
        s = new Socket();
        return s as unknown as TvSocket;
      },
    },
  );
  await tick();
  s?.emit(
    'message',
    JSON.stringify({ type: 'registered', id: 'register_0', payload: { 'client-key': 'fake' } }),
  );
  await tick();
  const req = JSON.parse(s?.sent.at(-1) ?? 'null') as { id: string };
  s?.emit('message', JSON.stringify({ type: 'response', id: req.id, payload: null }));
  await expect(p).rejects.toThrow();
});

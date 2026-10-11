import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

class S extends EventEmitter {
  constructor() {
    super();
    queueMicrotask(() => this.emit('open'));
  }
  close() {
    this.emit('close');
  }
  send(x: string) {
    const m = JSON.parse(x);
    queueMicrotask(() =>
      this.emit(
        'message',
        JSON.stringify(
          m.type === 'register'
            ? { id: m.id, type: 'registered', payload: { 'client-key': 'fake' } }
            : {
                id: m.id,
                type: 'response',
                payload: { returnValue: true, imageUri: 'https://attacker.invalid/image' },
              },
        ),
      ),
    );
  }
}
it('never downloads external uri and rejects 2byte junk', async () => {
  vi.resetModules();
  let downloaded = '';
  vi.doMock('node:https', () => ({
    default: {
      get: (uri: string, _opts: unknown, cb: (r: EventEmitter) => void) => {
        downloaded = uri;
        const r = new EventEmitter();
        cb(r);
        queueMicrotask(() => {
          r.emit('data', Buffer.from([255, 216]));
          r.emit('end');
        });
        return new EventEmitter();
      },
    },
  }));
  const { tvScreenshot } = await import('../src/tv/lgtv.js');
  await expect(tvScreenshot('192.168.1.237', 'fake', { factory: () => new S() })).rejects.toThrow();
  expect(downloaded).toBe('');
  vi.doUnmock('node:https');
});

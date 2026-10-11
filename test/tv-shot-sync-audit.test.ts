import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

class S extends EventEmitter {
  constructor() {
    super();
    queueMicrotask(() => this.emit('open'));
  }
  close() {}
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
                payload: { returnValue: true, imageUri: 'https://192.168.1.237/image' },
              },
        ),
      ),
    );
  }
}
it('sync download error clears timer', async () => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.doMock('node:https', () => ({
    default: {
      get: () => {
        throw new Error('sync failure');
      },
    },
  }));
  try {
    const { tvScreenshot } = await import('../src/tv/lgtv.js');
    await expect(
      tvScreenshot('192.168.1.237', 'fake', { factory: () => new S(), shotTimeoutMs: 10 }),
    ).rejects.toThrow('sync failure');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.doUnmock('node:https');
  }
});

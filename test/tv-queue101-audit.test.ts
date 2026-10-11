import { expect, it } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';

const d = (over: Partial<TvToolDeps>): TvToolDeps => ({
  shot: async () => ({ image: Buffer.alloc(1500), mimeType: 'image/jpeg' }),
  foreground: async () => ({ appId: 'x', category: [] }),
  apps: async () => [],
  launch: async () => {},
  key: async () => {},
  toast: async () => {},
  power: async () => {},
  saveFrame: () => '/tmp/f.jpg',
  getState: () => null,
  setState: () => {},
  ...over,
});
it('shot cannot race with another agent mutation', async () => {
  const events: string[] = [];
  let unlock!: () => void;
  const block = new Promise<void>((r) => {
    unlock = r;
  });
  const first = createTvTool(
    d({
      key: async () => {
        events.push('key-start');
        await block;
        events.push('key-end');
      },
    }),
  );
  const second = createTvTool(
    d({
      shot: async () => {
        events.push('shot');
        return { image: Buffer.alloc(1500), mimeType: 'image/jpeg' };
      },
    }),
  );
  const k = first.execute('k', { action: 'key', name: 'HOME' });
  await Promise.resolve();
  const s = second.execute('s', { action: 'screenshot' });
  await Promise.resolve();
  await Promise.resolve();
  unlock();
  await Promise.all([k, s]);
  expect(events).toEqual(['key-start', 'key-end', 'shot']);
});

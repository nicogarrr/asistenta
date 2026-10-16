import { expect, it, vi } from 'vitest';
import { ChannelRegistry } from '../src/channels/registry.js';
import type { ChannelAdapter } from '../src/channels/types.js';

it('strict registry close rejects a failed adapter and retains it as unconfirmed', async () => {
  const stop = vi.fn(async () => {
    throw new Error('synthetic channel close failure');
  });
  const adapter = { name: 'fixture', account: 'synthetic', stop } as unknown as ChannelAdapter;
  const registry = new ChannelRegistry();
  registry.register(adapter);
  await expect(registry.stopAll(true)).rejects.toThrow('cierre de todos los canales');
  expect(stop).toHaveBeenCalledWith(true);
  expect(registry.all()).toHaveLength(1);
  await expect(registry.stopAll()).resolves.toBeUndefined();
  expect(registry.all()).toHaveLength(0);
});

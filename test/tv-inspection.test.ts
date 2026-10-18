import { expect, it, vi } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';
import { inspectionMetrics, inspectTv } from '../src/tv/inspection.js';

it('reads inventory and live foreground without screenshots or any mutation', async () => {
  const forbidden = vi.fn(async () => {
    throw new Error('must not run');
  });
  const deps: TvToolDeps = {
    apps: async () => [{ id: 'netflix', title: 'Netflix' }],
    foreground: async () => ({ appId: 'netflix', category: [] }),
    stats: async () => ({ mem: { total: 2048, avail: 512 }, token: 'never-return' }),
    shot: forbidden,
    launch: forbidden,
    key: forbidden,
    toast: forbidden,
    power: forbidden,
    ghControl: forbidden,
    saveFrame: () => {
      throw new Error('must not save frames');
    },
    getState: () => null,
    setState: () => {
      throw new Error('must not overwrite last look');
    },
  };
  const result = await createTvTool(deps).execute('id', { action: 'inspect' });
  expect(forbidden).not.toHaveBeenCalled();
  expect(result.details).toMatchObject({
    platform: 'webos',
    readOnly: true,
    complete: true,
    changesApplied: false,
    atomic: false,
    apps: { status: 'ok', value: [{ id: 'netflix', title: 'Netflix' }] },
    metrics: { value: { memory: { totalKiB: 2048, availableKiB: 512, usedKiB: 1536 } } },
  });
  expect(JSON.stringify(result)).not.toContain('never-return');
});

it('keeps independent successes and does not turn errors into empty inventory or zero', async () => {
  const report = await inspectTv({
    apps: async () => {
      throw new Error('secret reflected');
    },
    foreground: async () => ({ appId: 'hdmi1', category: [] }),
  });
  expect(report.complete).toBe(false);
  expect(report.apps).toEqual({ status: 'unavailable' });
  expect(report.metrics).toEqual({ status: 'unavailable' });
  expect(report.foreground).toMatchObject({ status: 'ok', value: { appId: 'hdmi1' } });
  expect(JSON.stringify(report)).not.toContain('secret reflected');
});

it('preserves successful empty inventory and all-source failures honestly', async () => {
  expect(
    (
      await inspectTv({
        apps: async () => [],
        foreground: async () => {
          throw 0;
        },
      })
    ).apps,
  ).toEqual({ status: 'ok', value: [] });
  const bad = async () => {
    throw new Error('offline');
  };
  const report = await inspectTv({ apps: bad, foreground: bad, stats: bad });
  expect(report.complete).toBe(false);
  expect(report.metrics).toEqual({ status: 'unavailable' });
});

it.each([
  null,
  [],
  {},
  { mem: { total: -1, avail: 2 } },
  { mem: { total: 1, avail: 2 } },
  { mem: { total: '2048', avail: 1 }, temp: Number.NaN },
  { mem: { total: Number.POSITIVE_INFINITY, avail: 1 } },
])('does not invent metrics for malformed payload %j', (raw) => {
  expect(inspectionMetrics(raw).memory).toBeNull();
});

it('keeps actual zero available memory and omits unknown fields', () => {
  expect(
    inspectionMetrics({
      mem: { total: 1024, avail: 0 },
      swap: { total: 0, free: 0 },
      temp: 40,
      uptime: 0,
      mac: 'private',
    }),
  ).toEqual({
    memory: { totalKiB: 1024, availableKiB: 0, usedKiB: 1024 },
    swap: null,
    temperatureCelsius: 40,
    uptimeSeconds: 0,
  });
});

it.each([{}, null, { ok: false, mem: { total: 1024, avail: 20 } }])(
  'marks malformed or rejected stats unavailable, not a successful zero reading',
  async (stats) => {
    const report = await inspectTv({
      apps: async () => [],
      foreground: async () => ({ appId: 'netflix', category: [] }),
      stats: async () => stats,
    });
    expect(report.complete).toBe(false);
    expect(report.metrics).toEqual({ status: 'unavailable' });
  },
);

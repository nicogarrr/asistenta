import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMetrics, type WebBackend, WebRouter } from '../src/web/router.js';

// One metrics line per web request, forever: the file must not grow without end.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const backend = {
  id: 'a',
  ops: ['search'],
  costPerCallEur: 0,
  search: async () => ({ items: [{ title: 't', url: 'https://x.es', snippet: 's' }], chars: 2 }),
} as unknown as WebBackend;

describe('web metrics file is capped', () => {
  it('keeps the newest lines once it passes the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-webmetrics-'));
    dirs.push(dir);
    const metricsPath = join(dir, 'm.jsonl');
    const old = `${JSON.stringify({ op: 'search', backend: 'viejo', ok: true, ts: 1 })}\n`;
    writeFileSync(metricsPath, old.repeat(400));
    const router = new WebRouter({ backends: [backend], metricsPath, metricsMaxBytes: 4096 });
    await router.routeSearch('q', { host: 'x.es' });
    expect(statSync(metricsPath).size).toBeLessThanOrEqual(4096);
    const lines = await readMetrics(metricsPath);
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.at(-1)?.backend).toBe('a');
  });

  it('leaves a small file alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-webmetrics-'));
    dirs.push(dir);
    const metricsPath = join(dir, 'm.jsonl');
    const router = new WebRouter({ backends: [backend], metricsPath });
    await router.routeSearch('q', { host: 'x.es' });
    await router.routeSearch('q', { host: 'x.es' });
    expect(await readMetrics(metricsPath)).toHaveLength(2);
  });
});

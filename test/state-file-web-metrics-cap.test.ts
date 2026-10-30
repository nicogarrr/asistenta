import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { capAppendFile, pruneStateFiles } from '../src/maintenance.js';
import { capped, WEB_METRICS_MAX_BYTES } from '../src/state-files.js';

const DAY = 24 * 3_600_000;

function metricsFile(bytes: number): { root: string; file: string; lines: number } {
  const root = mkdtempSync(join(tmpdir(), 'pa-web-metrics-'));
  mkdirSync(join(root, 'log'), { recursive: true });
  const file = join(root, 'log', 'web-metrics.jsonl');
  const out: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const l = JSON.stringify({ i, provider: 'x', ms: 12, ok: true });
    out.push(l);
    size += l.length + 1;
  }
  writeFileSync(file, `${out.join('\n')}\n`);
  return { root, file, lines: out.length };
}

describe('log/web-metrics.jsonl tiene tope (registro de ficheros de estado)', () => {
  it('el registro declara el tope de web-metrics.jsonl', () => {
    expect(capped()).toContainEqual({
      file: 'log/web-metrics.jsonl',
      maxBytes: WEB_METRICS_MAX_BYTES,
    });
  });

  it('con la poda activa, un web-metrics.jsonl por encima del tope se recorta y deja las líneas recientes', () => {
    const { root, file, lines } = metricsFile(WEB_METRICS_MAX_BYTES + 4096);
    pruneStateFiles(root, 30 * DAY);
    const size = statSync(file).size;
    expect(size).toBeLessThanOrEqual(WEB_METRICS_MAX_BYTES / 2);
    const kept = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(kept.length).toBeGreaterThan(0);
    // Todas las líneas siguen siendo JSON válido y la última es la más reciente.
    for (const l of kept) JSON.parse(l);
    expect(JSON.parse(kept[kept.length - 1] as string).i).toBe(lines - 1);
  });

  it('por debajo del tope no se toca', () => {
    const { file } = metricsFile(1000);
    const before = readFileSync(file, 'utf8');
    expect(capAppendFile(file, WEB_METRICS_MAX_BYTES)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('un fichero que no existe no rompe la pasada', () => {
    expect(capAppendFile(join(tmpdir(), 'no-existe-pa.jsonl'), 10)).toBe(false);
  });
});

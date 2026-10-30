import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { DocMemory } = await import('../src/memory/docs.js');
const { documentRetentionDays, retentionIfDue } = await import('../src/maintenance.js');

const DAY = 24 * 3_600_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function shelf(clock: { t: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-doc-retention-'));
  dirs.push(dir);
  const mirror = join(dir, 'mirror');
  const docs = new DocMemory({
    dbPath: join(dir, 'docs.sqlite'),
    directory: mirror,
    now: () => clock.t,
  });
  return { docs, mirror };
}

describe('retención de documentos', () => {
  it('olvida los antiguos en el índice, en el FTS y en el mirror, y conserva los recientes', () => {
    const clock = { t: Date.UTC(2026, 0, 1) };
    const { docs, mirror } = shelf(clock);
    const mirrorOf = (d: { docId: string } | null) => {
      mkdirSync(mirror, { recursive: true });
      if (d) writeFileSync(join(mirror, `${d.docId}.txt`), 'texto');
    };
    mirrorOf(docs.indexOcr('telegram:1:100', 'viejo', 'factura de la luz enero texto antiguo'));
    mirrorOf(docs.indexOcr('telegram:1:200', 'viejo2', 'contrato de alquiler texto antiguo'));
    clock.t += 100 * DAY;
    mirrorOf(docs.indexOcr('telegram:1:100', 'nuevo', 'factura de la luz abril texto reciente'));
    expect(readdirSync(mirror)).toHaveLength(3);

    const removed = docs.pruneOlderThan(30 * DAY);

    expect(removed).toBe(2);
    expect(docs.stats('telegram:1:100').docs).toBe(1);
    expect(docs.stats('telegram:1:200').docs).toBe(0);
    expect(docs.search('telegram:1:100', 'antiguo')).toEqual([]);
    expect(docs.search('telegram:1:100', 'reciente')).toHaveLength(1);
    expect(readdirSync(mirror)).toHaveLength(1);
    expect(docs.pruneOlderThan(30 * DAY)).toBe(0);
  });

  it('está apagada por defecto y solo acepta días positivos', () => {
    expect(documentRetentionDays({})).toBe(0);
    expect(documentRetentionDays({ PA_DOCUMENT_RETENTION_DAYS: '' })).toBe(0);
    expect(documentRetentionDays({ PA_DOCUMENT_RETENTION_DAYS: '-3' })).toBe(0);
    expect(documentRetentionDays({ PA_DOCUMENT_RETENTION_DAYS: 'x' })).toBe(0);
    expect(documentRetentionDays({ PA_DOCUMENT_RETENTION_DAYS: '90' })).toBe(90);
  });

  it('la pasada diaria llama a pruneDocs con el plazo, aunque la de sesiones esté apagada', () => {
    const db = new DatabaseSync(':memory:');
    const pruneDocs = vi.fn(() => 4);
    const markRun = vi.fn();
    const r = retentionIfDue({
      db,
      now: new Date(2026, 9, 30, 4, 30),
      lastRunMs: 0,
      markRun,
      pruneDocs,
      env: { PA_SESSION_RETENTION_DAYS: '0', PA_DOCUMENT_RETENTION_DAYS: '90' },
    });
    expect(pruneDocs).toHaveBeenCalledWith(90 * DAY);
    expect(r).toEqual({ ran: true, sessions: 0, documents: 4, files: 0 });
    expect(markRun).toHaveBeenCalledOnce();
  });

  it('sin PA_DOCUMENT_RETENTION_DAYS no borra ningún documento', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE sessions (id TEXT, scope TEXT, started_at INTEGER, ended_at INTEGER);');
    db.exec('CREATE TABLE session_turns (session_id TEXT);');
    const pruneDocs = vi.fn(() => 1);
    retentionIfDue({
      db,
      now: new Date(2026, 9, 30, 5),
      lastRunMs: 0,
      markRun: () => {},
      pruneDocs,
      env: {},
    });
    expect(pruneDocs).not.toHaveBeenCalled();
  });

  it('el daemon pasa pruneDocs a la retención', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(join(import.meta.dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(cli).toMatch(/pruneDocs: \(ms\) => docMemory\.pruneOlderThan\(ms\)/);
    expect(existsSync(join(import.meta.dirname, '..', 'src', 'memory', 'docs.ts'))).toBe(true);
  });
});

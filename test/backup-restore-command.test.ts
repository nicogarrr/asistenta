import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runBackup } from '../src/backup.js';
import { listBackups, restoreBackup } from '../src/backup-restore.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function state(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-restore-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'memory'), { recursive: true });
  writeFileSync(join(dir, 'memory', 'nota.md'), 'vive en Valencia\n');
  const db = new DatabaseSync(join(dir, 'agent.db'));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('bueno')");
  db.close();
  return dir;
}
const value = (file: string): string => {
  const db = new DatabaseSync(file);
  try {
    return String((db.prepare('SELECT v FROM t').get() as { v: string }).v);
  } finally {
    db.close();
  }
};

describe('pa backup restaurar', () => {
  it('restaura la copia del día y aparta lo que había (deshacible)', () => {
    const dir = state();
    runBackup({ stateDir: dir, now: new Date(2026, 9, 28, 3, 0) });
    writeFileSync(join(dir, 'memory', 'nota.md'), 'corrupto\n');
    expect(listBackups(join(dir, 'backups'))).toEqual(['2026-10-28']);
    const r = restoreBackup({ stateDir: dir, date: '2026-10-28' });
    expect(readFileSync(join(dir, 'memory', 'nota.md'), 'utf8')).toBe('vive en Valencia\n');
    expect(value(join(dir, 'agent.db'))).toBe('bueno');
    expect(readFileSync(join(r.savedDir, 'memory', 'nota.md'), 'utf8')).toBe('corrupto\n');
  });

  it('aparta el -wal/-shm viejo para que no se mezcle con la base restaurada', () => {
    const dir = state();
    runBackup({ stateDir: dir, now: new Date(2026, 9, 28, 3, 0) });
    writeFileSync(join(dir, 'agent.db-wal'), 'basura de otro momento');
    writeFileSync(join(dir, 'agent.db-shm'), 'x');
    const r = restoreBackup({ stateDir: dir, date: 'ultima' });
    expect(existsSync(join(dir, 'agent.db-wal'))).toBe(false);
    expect(existsSync(join(dir, 'agent.db-shm'))).toBe(false);
    expect(existsSync(join(r.savedDir, 'agent.db-wal'))).toBe(true);
    expect(value(join(dir, 'agent.db'))).toBe('bueno');
  });

  it('una fecha inexistente o con ../ no toca nada y dice las disponibles', () => {
    const dir = state();
    runBackup({ stateDir: dir, now: new Date(2026, 9, 28, 3, 0) });
    expect(() => restoreBackup({ stateDir: dir, date: '2026-01-01' })).toThrow(/2026-10-28/);
    expect(() => restoreBackup({ stateDir: dir, date: '../..' })).toThrow(/disponibles/);
    expect(readFileSync(join(dir, 'memory', 'nota.md'), 'utf8')).toBe('vive en Valencia\n');
  });
});

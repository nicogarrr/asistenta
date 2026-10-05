import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isBackupDue, runBackup } from '../src/backup.js';

function stateWithData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  const db = new DatabaseSync(join(dir, 'memory.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE t (v TEXT)');
  db.prepare('INSERT INTO t VALUES (?)').run('hola');
  mkdirSync(join(dir, 'memory'));
  writeFileSync(join(dir, 'memory', 'a.md'), 'dato');
  mkdirSync(join(dir, 'browser'));
  writeFileSync(join(dir, 'browser', 'cookies'), 'no');
  writeFileSync(join(dir, 'vault.enc'), 'secreto');
  return dir; // la base queda abierta a propósito: la copia tiene que ser coherente igual
}

describe('copia de seguridad nocturna', () => {
  it('copia bases y memoria, y deja fuera navegador y vault', () => {
    const dir = stateWithData();
    const r = runBackup({ stateDir: dir, now: new Date(2026, 9, 5, 3, 10) });
    expect(r.dir).toBe(join(dir, 'backups', '2026-10-05'));
    expect(r.databases).toEqual(['memory.db']);
    const copy = new DatabaseSync(join(r.dir, 'memory.db'));
    expect((copy.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('hola');
    copy.close();
    expect(readFileSync(join(r.dir, 'memory', 'a.md'), 'utf8')).toBe('dato');
    expect(existsSync(join(r.dir, 'browser'))).toBe(false);
    expect(existsSync(join(r.dir, 'vault.enc'))).toBe(false);
  });

  it('conserva solo las últimas N y la de hoy se puede repetir', () => {
    const dir = stateWithData();
    for (let d = 1; d <= 5; d++)
      runBackup({ stateDir: dir, now: new Date(2026, 9, d, 3), keep: 3 });
    runBackup({ stateDir: dir, now: new Date(2026, 9, 5, 4), keep: 3 });
    expect(readdirSync(join(dir, 'backups')).sort()).toEqual([
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
  });

  it('toca cada día a partir de las 03:00 y no antes ni dos veces', () => {
    const last = new Date(2026, 9, 5, 3, 10).getTime();
    expect(isBackupDue(new Date(2026, 9, 5, 2, 0), 0)).toBe(false);
    expect(isBackupDue(new Date(2026, 9, 5, 3, 0), 0)).toBe(true);
    expect(isBackupDue(new Date(2026, 9, 5, 15, 0), last)).toBe(false);
    expect(isBackupDue(new Date(2026, 9, 6, 3, 5), last)).toBe(true);
  });

  it('un fallo a medias no pierde la copia buena ni deja una parcial', () => {
    const dir = stateWithData();
    const day = new Date(2026, 9, 5, 3);
    const ok = runBackup({ stateDir: dir, now: day });
    writeFileSync(join(dir, 'roto.db'), 'esto no es sqlite');
    expect(() => runBackup({ stateDir: dir, now: day })).toThrow();
    expect(readdirSync(join(dir, 'backups'))).toEqual(['2026-10-05']);
    const copy = new DatabaseSync(join(ok.dir, 'memory.db'));
    expect((copy.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('hola');
    copy.close();
  });

  it('PA_BACKUP_DIR: las copias van a otra carpeta', () => {
    const dir = stateWithData();
    const other = mkdtempSync(join(tmpdir(), 'bk-other-'));
    const r = runBackup({ stateDir: dir, destDir: other, now: new Date(2026, 9, 5, 3) });
    expect(r.dir).toBe(join(other, '2026-10-05'));
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });
});

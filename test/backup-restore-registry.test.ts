import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runBackup } from '../src/backup.js';
import { restorable, restoreBackup } from '../src/backup-restore.js';
import { STATE_ENTRIES } from '../src/state-files.js';

function fillState(state: string): void {
  for (const e of STATE_ENTRIES) {
    if (e.name === 'backups') continue;
    const p = join(state, e.name);
    if (e.backup === 'db') {
      const db = new DatabaseSync(p);
      db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('ok')");
      db.close();
    } else if (e.backup === 'docs') {
      mkdirSync(join(p, 'mirror'), { recursive: true });
      writeFileSync(join(p, 'mirror', 'a.txt'), 'texto');
      new DatabaseSync(join(p, 'docs.sqlite')).close();
    } else if (e.backup === 'dir' || (e.backup === false && !e.name.includes('.'))) {
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 'x.txt'), e.name);
    } else {
      writeFileSync(p, e.name);
    }
  }
}

describe('pa backup restaurar usa el registro de ficheros de estado', () => {
  it('ida y vuelta: todo lo que el registro respalda vuelve tras restaurar', () => {
    const state = mkdtempSync(join(tmpdir(), 'pa-restore-reg-'));
    fillState(state);
    runBackup({ stateDir: state, destDir: join(state, 'backups'), now: new Date(2026, 9, 30, 4) });
    const backed = STATE_ENTRIES.filter((e) => e.backup !== false).map((e) => e.name);
    for (const name of backed) rmSync(join(state, name), { recursive: true, force: true });
    const r = restoreBackup({ stateDir: state, date: 'ultima', now: new Date(2026, 9, 30, 9) });
    expect(r.restored.sort()).toEqual([...backed].sort());
    expect(r.skipped).toEqual([]);
    for (const name of backed) expect(existsSync(join(state, name)), name).toBe(true);
    expect(readFileSync(join(state, 'docs', 'mirror', 'a.txt'), 'utf8')).toBe('texto');
  });

  it('lo excluido o desconocido que aparezca en una copia no se restaura ni aparta lo actual', () => {
    const state = mkdtempSync(join(tmpdir(), 'pa-restore-reg-'));
    const day = join(state, 'backups', '2026-10-29');
    const excluded = STATE_ENTRIES.filter((e) => e.backup === false && e.name !== 'backups').map(
      (e) => e.name,
    );
    expect(excluded.length).toBeGreaterThan(3);
    mkdirSync(day, { recursive: true });
    for (const name of excluded) writeFileSync(join(day, name), 'de la copia');
    mkdirSync(join(day, 'raro'));
    writeFileSync(join(day, 'otro.json'), '{}');
    writeFileSync(join(state, excluded[0] as string), 'actual');
    const r = restoreBackup({ stateDir: state, date: '2026-10-29' });
    expect(r.restored).toEqual(['otro.json']);
    expect(r.skipped.sort()).toEqual([...excluded, 'raro'].sort());
    expect(readFileSync(join(state, excluded[0] as string), 'utf8')).toBe('actual');
    expect(r.savedDir).toBe('');
  });

  it('restorable sigue al registro', () => {
    for (const e of STATE_ENTRIES) expect(restorable(e.name), e.name).toBe(e.backup !== false);
    expect(restorable('nuevo.json')).toBe(true);
    expect(restorable('nuevo.db')).toBe(true);
    expect(restorable('carpeta-rara')).toBe(false);
  });
});

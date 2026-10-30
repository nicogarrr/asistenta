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
import { runBackup } from '../src/backup.js';
import { STATE_ENTRIES } from '../src/state-files.js';

/** Todos los ficheros .ts de src/, recursivo. */
function sources(dir = 'src'): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Nombres de primer nivel del estado que usa el código: join(<estado>, '<nombre>'…). */
function usedStateNames(): Map<string, string> {
  const re =
    /join\(\s*(?:paths\.state|STATE_DIR|stateDir|opts\.stateDir|this\.stateDir|deps\.stateDir|ctx\.stateDir|state)\s*,\s*'([^']+)'/g;
  const found = new Map<string, string>();
  for (const file of sources()) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      const name = m[1];
      if (name && !found.has(name)) found.set(name, file);
    }
  }
  return found;
}

describe('registro único de ficheros de estado', () => {
  it('cada nombre de estado que usa src/ está en el registro', () => {
    const known = new Set(STATE_ENTRIES.map((e) => e.name));
    const missing = [...usedStateNames()]
      .filter(([name]) => !known.has(name))
      .map(([name, file]) => `${name} (${file})`);
    expect(missing, 'añádelo a src/state-files.ts y di si va en la copia').toEqual([]);
  });

  it('no hay nombres repetidos y cada exclusión dice por qué', () => {
    const names = STATE_ENTRIES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const e of STATE_ENTRIES) if (e.backup === false) expect(e.why.length).toBeGreaterThan(3);
  });

  it('la copia nocturna lleva todo lo que el registro dice y nada de lo excluido', () => {
    const state = mkdtempSync(join(tmpdir(), 'pa-state-files-'));
    for (const e of STATE_ENTRIES) {
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
    const r = runBackup({
      stateDir: state,
      destDir: join(state, 'backups'),
      now: new Date(2026, 9, 30, 4),
    });
    const copied = STATE_ENTRIES.filter((e) => existsSync(join(r.dir, e.name))).map((e) => e.name);
    const expected = STATE_ENTRIES.filter((e) => e.backup !== false).map((e) => e.name);
    expect(copied.sort()).toEqual(expected.sort());
    expect(existsSync(join(r.dir, 'docs', 'mirror', 'a.txt'))).toBe(true);
    expect(existsSync(join(r.dir, 'docs', 'docs.sqlite'))).toBe(true);
  });
});

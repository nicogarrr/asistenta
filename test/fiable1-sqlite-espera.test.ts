import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDatabaseSync, openSqlite, SQLITE_BUSY_TIMEOUT_MS } from '../src/sqlite.js';

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** Otro proceso coge la base en exclusiva `ms` milisegundos; resuelve cuando ya la tiene. */
function holdLock(file: string, ms: number): Promise<{ released: Promise<void> }> {
  const code = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec('BEGIN EXCLUSIVE');
    process.stdout.write('locked\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0); }, ${ms});
  `;
  const child = spawn(process.execPath, ['--no-warnings', '-e', code], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const done = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (b: Buffer) => {
      if (b.toString().includes('locked')) resolve({ released: done });
    });
    child.on('error', reject);
  });
}

describe('bases SQLite compartidas: esperan en vez de «database is locked»', () => {
  it('openSqlite pone la espera de 5 s y WAL si se pide', () => {
    dir = mkdtempSync(join(tmpdir(), 'pa-sqlite-'));
    const db = openSqlite(join(dir, 'goals.db'), { wal: true });
    expect(SQLITE_BUSY_TIMEOUT_MS).toBe(5000);
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    db.close();
    const plain = openSqlite(join(dir, 'approvals.db'));
    expect(plain.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    plain.close();
  });

  it('con otro proceso escribiendo, la escritura espera y entra (antes fallaba al instante)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pa-sqlite-'));
    const file = join(dir, 'goals.db');
    const setup = openSqlite(file);
    setup.exec('CREATE TABLE t (x INTEGER)');
    setup.close();

    // Sin espera (como goals.db y voice.db antes): falla al momento.
    const Db = loadDatabaseSync();
    const raw = new Db(file);
    const { released } = await holdLock(file, 600);
    expect(() => raw.exec('INSERT INTO t VALUES (1)')).toThrow(/locked|busy/i);
    raw.close();
    await released;

    // Con openSqlite: espera a que el otro suelte y la fila entra.
    const db = openSqlite(file);
    const { released: released2 } = await holdLock(file, 400);
    const t0 = Date.now();
    db.exec('INSERT INTO t VALUES (2)');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(db.prepare('SELECT x FROM t').all()).toEqual([{ x: 2 }]);
    db.close();
    await released2;
  }, 20_000);

  it('el daemon, el MCP y los permisos abren sus bases con openSqlite', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    for (const name of ['memory.db', 'goals.db', 'voice.db']) {
      expect(cli).toContain(`openSqlite(join(paths.state, '${name}'), { wal: true })`);
    }
    const mcp = readFileSync('src/mcp/serve-cli.ts', 'utf8');
    expect(mcp).toContain("openSqlite(join(paths.state, 'goals.db'), { wal: true })");
    const perms = readFileSync('src/permissions.ts', 'utf8');
    expect(perms).not.toMatch(/new DatabaseSync\(/);
  });
});

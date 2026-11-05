import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocMemory } from '../src/memory/docs.js';

// La memoria de documentos (docs.sqlite) abría su base sin espera: si la copia de
// seguridad diaria la estaba leyendo u otro proceso la tenía, guardar un documento
// fallaba al instante con «database is locked».
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

describe('memoria de documentos con la base cogida', () => {
  it('guardar un documento espera a que la suelten y entra', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pa-docs-espera-'));
    const dbPath = join(dir, 'docs.sqlite');
    const docs = new DocMemory({ dbPath, directory: join(dir, 'mirror') });
    const { released } = await holdLock(dbPath, 500);
    const t0 = Date.now();
    const indexed = await docs.index(
      'telegram:dm:1',
      { name: 'factura.txt', mimeType: 'text/plain' } as never,
      Buffer.from('Factura de la luz de octubre: 54,20 euros.'),
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(indexed).not.toBeNull();
    expect(docs.search('telegram:dm:1', 'factura').length).toBeGreaterThan(0);
    docs.close();
    await released;
  }, 20_000);
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFailText, vigilanciasCommand } from '../src/watch/overview-cli.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

describe('pa vigilancias: una base que no se puede leer se explica en castellano', () => {
  it('memory.db dañado: dice que está dañado y cómo restaurar, sin el texto de SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-vig-dañado-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, 'memory.db'),
      'esto no es una base de datos SQLite, solo texto suelto '.repeat(40),
    );
    let out = '';
    const code = await vigilanciasCommand(
      [],
      { stateDir: dir, agentDb: join(dir, 'no-hay.db') },
      (s) => {
        out += s;
      },
    );
    expect(code).toBe(1);
    expect(out).toContain('no se pudo leer páginas: el fichero de datos está dañado');
    expect(out).toContain('pa backup restaurar ultima');
    expect(out).not.toMatch(/not a database|SQLITE|malformed/i);
  });

  it('base ocupada, sin permiso y error raro', () => {
    expect(
      readFailText(
        'rutinas',
        Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }),
      ),
    ).toContain('ocupada ahora mismo');
    expect(readFailText('páginas', new Error('unable to open database file'))).toContain(
      'no puedo abrir',
    );
    const odd = readFailText('ojo', new Error('no such column: foo_bar'));
    expect(odd).toContain('error inesperado');
    expect(odd).not.toContain('foo_bar');
  });
});

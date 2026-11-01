import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreBackup } from '../src/backup-restore.js';

// «pa backup restaurar» que fallaba a medias (un fichero bloqueado en Windows, sin
// permiso, disco lleno) dejaba el estado mezclado — unos ficheros de la copia, otros
// apartados — y enseñaba el error crudo de Node («EBUSY: resource busy or locked…»).
// Ahora deja todo como estaba y lo dice en castellano.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-bugs6-restore-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'a.json'), 'a-ahora');
  writeFileSync(join(dir, 'b.json'), 'b-ahora');
  const copy = join(dir, 'backups', '2026-10-31');
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, 'a.json'), 'a-copia');
  writeFileSync(join(copy, 'b.json'), 'b-copia');
  return dir;
}

const fail = (code: string) => (from: string) => {
  if (from.endsWith('b.json'))
    throw Object.assign(new Error(`${code}: resource busy or locked, copyfile '${from}'`), {
      code,
    });
};

describe('pa backup restaurar que falla a medias', () => {
  it('deja el estado como estaba', () => {
    const dir = setup();
    expect(() =>
      restoreBackup({ stateDir: dir, date: '2026-10-31', copy: fail('EBUSY') }),
    ).toThrow();
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe('a-ahora');
    expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('b-ahora');
    expect(readdirSync(join(dir, 'backups'))).toEqual(['2026-10-31']);
  });

  it('lo dice en castellano, sin el error crudo', () => {
    const msg = (code: string): string => {
      try {
        restoreBackup({ stateDir: setup(), date: '2026-10-31', copy: fail(code) });
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(msg('EBUSY')).toBe(
      'No he podido restaurar la copia del 2026-10-31: b.json está abierto por otro programa. No he cambiado nada.',
    );
    expect(msg('EPERM')).toBe(
      'No he podido restaurar la copia del 2026-10-31: no tengo permiso para escribir b.json. No he cambiado nada.',
    );
    expect(msg('ENOSPC')).toBe(
      'No he podido restaurar la copia del 2026-10-31: no queda espacio en el disco. No he cambiado nada.',
    );
    expect(msg('EIO')).toBe(
      'No he podido restaurar la copia del 2026-10-31: falló al copiar b.json. No he cambiado nada.',
    );
  });

  it('sin fallos restaura como siempre', () => {
    const dir = setup();
    const r = restoreBackup({ stateDir: dir, date: '2026-10-31' });
    expect(r.restored.sort()).toEqual(['a.json', 'b.json']);
    expect(readFileSync(join(dir, 'b.json'), 'utf8')).toBe('b-copia');
  });
});

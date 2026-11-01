import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BackupMirrorError,
  backupMirrorNotice,
  localBackupDone,
  runBackup,
} from '../src/backup.js';
import { backupFailedNotice } from '../src/cli.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
});

function state(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bk-espejo-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'memory'));
  writeFileSync(join(dir, 'memory', 'a.md'), 'dato');
  writeFileSync(join(dir, 'alertas.json'), '{}');
  return dir;
}

/** PA_BACKUP_MIRROR apunta dentro de un fichero: como un disco USB desconectado. */
function mirrorFails(dir: string): unknown {
  const blocked = join(dir, 'usb');
  writeFileSync(blocked, 'no soy una carpeta');
  try {
    runBackup({ stateDir: dir, mirrorDir: join(blocked, 'copias'), now: new Date(2026, 9, 31, 3) });
  } catch (err) {
    return err;
  }
  throw new Error('runBackup no lanzó');
}

describe('copia de seguridad: falla solo el segundo destino', () => {
  it('la copia local cuenta como hecha (no se repite cada 10 minutos)', () => {
    const dir = state();
    const err = mirrorFails(dir);
    expect(err).toBeInstanceOf(BackupMirrorError);
    expect(localBackupDone(err)).toBe(true);
    expect(existsSync(join(dir, 'backups', '2026-10-31', 'memory', 'a.md'))).toBe(true);
    expect((err as Error).message).toMatch(/segundo destino/);
  });

  it('un fallo de la copia local no cuenta como hecha', () => {
    expect(localBackupDone(new Error('ENOSPC: no space left on device'))).toBe(false);
    expect(localBackupDone(undefined)).toBe(false);
  });

  it('el aviso dice que la local está hecha y qué pasa con el espejo, sin códigos', () => {
    const err = mirrorFails(state());
    const text = backupFailedNotice(err);
    expect(text).toContain('He hecho la copia de seguridad de hoy en este PC');
    expect(text).toContain('no encuentro esa carpeta');
    expect(text).not.toMatch(/No he podido hacer la copia|ENOTDIR|ENOENT|Error:/);
  });

  it('motivos del espejo en castellano', () => {
    const e = (code: string) =>
      backupMirrorNotice(
        new BackupMirrorError(
          'C:\\pa\\backups\\x',
          'E:\\Copias',
          Object.assign(new Error(code), { code }),
        ),
      );
    expect(e('EACCES')).toContain('no tengo permiso para escribir ahí');
    expect(e('ENOSPC')).toContain('ese disco está lleno');
    expect(e('ENOENT')).toContain('¿Está conectado ese disco?');
    expect(e('EWHATEVER')).toMatch(/E:\\Copias\. Lo intento otra vez mañana\.$/);
    expect(e('EWHATEVER')).not.toContain('EWHATEVER');
  });
});

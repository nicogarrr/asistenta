import { describe, expect, it } from 'vitest';
import { backupFailedNotice } from '../src/cli.js';

const errno = (msg: string, code: string) => Object.assign(new Error(msg), { code });

describe('aviso de copia de seguridad fallida en castellano y sin texto técnico', () => {
  it('disco lleno', () => {
    const r = backupFailedNotice(
      errno("ENOSPC: no space left on device, write 'C:\\Users\\nico\\b.zip'", 'ENOSPC'),
    );
    expect(r).toBe(
      'No he podido hacer la copia de seguridad de hoy: el disco está lleno. Libera espacio; lo reintento en unos minutos.',
    );
  });

  it('sin permiso', () => {
    const r = backupFailedNotice(
      errno("EACCES: permission denied, open '/home/n/.pa/backups/x'", 'EACCES'),
    );
    expect(r).toContain('no tengo permiso para escribir en la carpeta de copias');
    expect(r).not.toMatch(/EACCES|permission|\/home/);
  });

  it('archivo en uso', () => {
    expect(backupFailedNotice(errno('EBUSY: resource busy or locked', 'EBUSY'))).toContain(
      'había un archivo en uso',
    );
  });

  it('una traza técnica no llega al chat', () => {
    const r = backupFailedNotice(
      new Error('TypeError: x is not a function\n    at run (C:\\a\\b.js:1:2)'),
    );
    expect(r).toBe(
      'No he podido hacer la copia de seguridad de hoy (detalles en el registro). Lo reintento en unos minutos.',
    );
  });

  it('un motivo en castellano se conserva', () => {
    expect(backupFailedNotice(new Error('La carpeta de copias no existe'))).toBe(
      'No he podido hacer la copia de seguridad de hoy: La carpeta de copias no existe. Lo reintento en unos minutos.',
    );
  });
});

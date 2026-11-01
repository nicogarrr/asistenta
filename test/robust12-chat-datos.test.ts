import { describe, expect, it } from 'vitest';
import { friendlyError } from '../src/channels/formatters.js';

const withCode = (message: string, code: string): Error =>
  Object.assign(new Error(message), { code });

describe('chat: fallos de disco y de datos en castellano', () => {
  it('disco lleno, sin la ruta ni ENOSPC', () => {
    const out = friendlyError(
      withCode(
        "ENOSPC: no space left on device, open 'C:\\Users\\Ana\\.personal-agent\\state\\x.json'",
        'ENOSPC',
      ),
      'Algo falló: ',
    );
    expect(out).toMatch(/disco del PC está lleno/);
    expect(out).not.toMatch(/ENOSPC|Users|space/);
  });

  it('base de datos dañada', () => {
    const out = friendlyError(withCode('file is not a database', 'ERR_SQLITE_ERROR'));
    expect(out).toMatch(/dañado/);
    expect(out).toContain('pa backup restaurar ultima');
    expect(friendlyError(new Error('database disk image is malformed'))).toMatch(/dañado/);
  });

  it('datos ocupados por otro programa', () => {
    expect(friendlyError(withCode('database is locked', 'ERR_SQLITE_ERROR'))).toMatch(
      /Otro programa/,
    );
    expect(
      friendlyError(withCode("EBUSY: resource busy or locked, open 'C:\\x\\a.db'", 'EBUSY')),
    ).toMatch(/Otro programa/);
  });

  it('permiso denegado al abrir un fichero', () => {
    const out = friendlyError(
      withCode("EPERM: operation not permitted, rename 'C:\\a.tmp' -> 'C:\\a.json'", 'EPERM'),
    );
    expect(out).toMatch(/permiso denegado/);
    expect(out).not.toMatch(/EPERM|rename/);
  });

  it('un mensaje propio corto sigue igual', () => {
    expect(friendlyError(new Error('No encuentro ese id'), 'Error: ')).toBe(
      'Error: No encuentro ese id',
    );
  });
});

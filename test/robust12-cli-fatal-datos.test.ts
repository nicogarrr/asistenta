import { describe, expect, it } from 'vitest';
import { cliFatalMessage } from '../src/cli-messages.js';

const sqliteErr = (message: string, errcode: number): Error =>
  Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode, errstr: message });
const fsErr = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe('pa: fallos de los ficheros de datos al arrancar, en castellano', () => {
  it('base de datos dañada (tras un apagón)', () => {
    const out = cliFatalMessage(sqliteErr('file is not a database', 26));
    expect(out).toMatch(/dañado/);
    expect(out).toContain('pa backup restaurar ultima');
    expect(out).not.toMatch(/database/);
    expect(cliFatalMessage(sqliteErr('database disk image is malformed', 11))).toMatch(/dañado/);
  });

  it('disco lleno', () => {
    const out = cliFatalMessage(
      fsErr(
        "ENOSPC: no space left on device, open 'C:\\Users\\Ana\\.personal-agent\\x.json'",
        'ENOSPC',
      ),
    );
    expect(out).toMatch(/disco está lleno/);
    expect(out).not.toMatch(/ENOSPC|Users/);
    expect(cliFatalMessage(sqliteErr('database or disk is full', 13))).toMatch(/disco está lleno/);
  });

  it('datos ocupados por otro programa', () => {
    expect(cliFatalMessage(sqliteErr('database is locked', 5))).toMatch(/Otro programa/);
    expect(
      cliFatalMessage(fsErr("EBUSY: resource busy or locked, open 'C:\\x\\memory.db'", 'EBUSY')),
    ).toMatch(/Otro programa/);
  });

  it('sin permiso para abrir los datos', () => {
    const out = cliFatalMessage(
      fsErr("EPERM: operation not permitted, open 'C:\\x\\state.json'", 'EPERM'),
    );
    expect(out).toMatch(/permiso denegado/);
    expect(out).not.toMatch(/EPERM/);
    expect(cliFatalMessage(sqliteErr('unable to open database file', 14))).toMatch(
      /permiso denegado/,
    );
  });

  it('lo demás sale igual que antes', () => {
    expect(cliFatalMessage(new Error('algo raro'))).toBe('algo raro');
    expect(cliFatalMessage(fsErr('listen EACCES: permission denied 0.0.0.0:80', 'EACCES'))).toBe(
      'listen EACCES: permission denied 0.0.0.0:80',
    );
  });
});

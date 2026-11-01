import { describe, expect, it } from 'vitest';
import { plainWriteError } from '../src/tools/memory.js';

describe('memoria: fallo al guardar en castellano llano', () => {
  const raw: [string, string, string, string, string] = [
    "ENOSPC: no space left on device, write 'C:\\Users\\Nico\\Asistenta\\state\\memory\\chat-1.jsonl'",
    "EPERM: operation not permitted, open 'C:\\Users\\Nico\\Asistenta\\state\\PERFIL.md'",
    "EBUSY: resource busy or locked, rename 'C:\\x.tmp' -> 'C:\\PERFIL.md'",
    'SQLITE_IOERR: disk I/O error',
    'undefined',
  ];
  it.each(raw)('no enseña rutas ni códigos: %s', (r) => {
    const out = plainWriteError(r);
    expect(out).not.toMatch(/E[A-Z]{3,}|C:\\|\.jsonl|\.md|SQLITE|undefined|Error/);
    expect(out.length).toBeGreaterThan(10);
  });
  it('dice qué pasa en los casos comunes', () => {
    expect(plainWriteError(raw[0])).toContain('disco está lleno');
    expect(plainWriteError(raw[1])).toContain('no me deja escribir');
    expect(plainWriteError(raw[2])).toContain('no me deja escribir');
    expect(plainWriteError(raw[3])).toBe('el disco rechazó la escritura');
  });
});

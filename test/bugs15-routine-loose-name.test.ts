import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { routineNameAnswer } from '../src/daemon/pregunta-pendiente.js';

// «/routine Pedir cita» decía «No tengo ninguna rutina llamada "Pedir"» con la rutina
// «pedir-cita» guardada: solo valía el nombre exacto con guiones y en minúsculas.
const cli = readFileSync('src/cli.ts', 'utf8');
const body = cli.slice(
  cli.indexOf('const cmdRoutine = async'),
  cli.indexOf('// A macro takes clave=valor'),
);

describe('/routine con el nombre dicho normal', () => {
  it('antes de dar la rutina por desconocida, la busca sin mayúsculas, tildes ni guiones', () => {
    const fallback = body.indexOf('const loose = routineNameAnswer(');
    expect(fallback).toBeGreaterThan(body.indexOf('if (!routine) {'));
    expect(fallback).toBeLessThan(body.indexOf('const parsed = parseNatural(args.trim())'));
    expect(body).toContain(
      'if (again && again !== args.trim()) return cmdRoutine(thread, inbound, again);',
    );
  });

  it('el nombre entero o la primera palabra (con los datos de la macro detrás)', () => {
    const loose = routineNameAnswer(['pedir-cita', 'informe', 'macro/archiva']);
    expect(loose('Pedir cita')).toBe('pedir-cita');
    expect(loose('Informe')).toBe('informe');
    expect(loose('Macro/Archiva')).toBe('macro/archiva');
    expect(loose('cada mañana a las 8 resumen')).toBeNull();
  });
});

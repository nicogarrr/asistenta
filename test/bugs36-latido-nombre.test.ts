import { describe, expect, it } from 'vitest';
import { latidoRoutineName } from '../src/daemon/latido.js';
import { RoutineStops } from '../src/daemon/rutina-parar.js';

// bugs-36 (lead de bugs-35, revisión de #2313): cada comprobación «cada N min» corre como
// rutina llamada «latido: <60 primeros caracteres de la tarea>», y «deja de vigilar» corta
// las que corren con ese nombre. Dos vigilancias en el mismo chat que empiezan igual
// compartían nombre: parar una cortaba también la comprobación en marcha de la otra.

const comun = 'mira si baja el precio de las zapatillas Nike Pegasus 41 talla 43 en';
const a = { id: 'm1a', task: `${comun} Zalando` };
const b = { id: 'm1b', task: `${comun} Decathlon` };

describe('vigilancias que empiezan igual', () => {
  it('tienen nombres distintos', () => {
    expect(latidoRoutineName(a)).not.toBe(latidoRoutineName(b));
    expect(latidoRoutineName(a).startsWith('latido: mira si baja')).toBe(true);
  });

  it('parar una no corta la comprobación en marcha de la otra', () => {
    const stops = new RoutineStops();
    const scope = 'telegram:main:1';
    let abortedA = 0;
    let abortedB = 0;
    stops.begin(scope, latidoRoutineName(a)).started(() => abortedA++);
    stops.begin(scope, latidoRoutineName(b)).started(() => abortedB++);
    expect(stops.stop(scope, latidoRoutineName(a))).toBe('parada');
    expect(abortedA).toBe(1);
    expect(abortedB).toBe(0);
    expect(stops.isActive(scope, latidoRoutineName(b))).toBe(true);
  });
});

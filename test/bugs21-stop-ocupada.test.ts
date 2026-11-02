/**
 * /stop libera la «ocupada» pegada (#1902), pero cuando el turno colgado acaba de verdad
 * su cierre descontaba otra vez: el contador de turnos quedaba por debajo de lo real
 * mientras otro turno seguía abierto (y llegaba a 0 con un turno en marcha). Ahora un
 * turno ya liberado no descuenta al cerrarse. Y la etiqueta (lo que se pidió, que sale en
 * «Espera: una tarea («…»)» y en el aviso de tareas cortadas) ya no se corta a medio emoji.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { busyBegin, releaseBusyOpenedBefore, trackBusyIn } from '../src/ocupada.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-busy-stop-'));
  trackBusyIn(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const disk = () =>
  JSON.parse(readFileSync(join(dir, 'autoupdate', 'ocupada.json'), 'utf8')) as {
    turnos: number;
    items: Array<{ label: string }>;
  };

describe('/stop y el cierre tardío de un turno colgado', () => {
  it('el turno liberado por /stop no descuenta otra vez al acabar', () => {
    const endA = busyBegin('turnos', 'colgado');
    expect(releaseBusyOpenedBefore(Date.now() + 1)).toBe(1);
    const endB = busyBegin('turnos', 'nuevo');
    endA();
    expect(disk().turnos).toBe(1);
    expect(disk().items.map((i) => i.label)).toEqual(['nuevo']);
    endB();
    expect(disk().turnos).toBe(0);
  });

  it('la etiqueta larga no se corta a medio emoji', () => {
    const end = busyBegin('turnos', `${'a'.repeat(79)}😀 y más`);
    const label = disk().items[0]?.label ?? '';
    expect(label).toBe('a'.repeat(79));
    expect(label).not.toMatch(/[\uD800-\uDBFF]$/);
    end();
  });
});

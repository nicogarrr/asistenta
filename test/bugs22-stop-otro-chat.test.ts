/**
 * /stop en un chat liberaba, 5 s después, TODOS los turnos y permisos abiertos antes del /stop
 * en todo el proceso (#1902): también los de otro chat (un grupo, otro tema) que seguían en
 * marcha de verdad, y un permiso que esperaba respuesta allí. Con eso la autoactualización
 * veía «libre» y podía reiniciar a Asistenta en mitad de ese turno, justo lo que «ocupada»
 * existe para evitar. Ahora solo se libera lo del chat parado (y lo que no tiene dueño).
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { busyBegin, openBusyItems, releaseBusyOpenedBefore } from '../src/ocupada.js';

afterEach(() => {
  releaseBusyOpenedBefore(Date.now() + 60_000);
});

describe('/stop solo libera lo de su chat', () => {
  it('lo de otro chat sigue abierto; lo del chat parado y lo sin dueño se libera', () => {
    busyBegin('turnos', 'resume mi correo', 'telegram:111');
    busyBegin('turnos', 'busca vuelos', 'telegram:-222');
    busyBegin('aprobaciones', 'permiso', 'telegram:-222');
    busyBegin('turnos', 'especialista');
    expect(releaseBusyOpenedBefore(Date.now() + 1, 'telegram:111')).toBe(2);
    expect(
      openBusyItems()
        .map((i) => i.label)
        .sort(),
    ).toEqual(['busca vuelos', 'permiso']);
  });

  it('sin chat (como antes) libera todo lo abierto antes del corte', () => {
    busyBegin('turnos', 'a', 'telegram:1');
    busyBegin('turnos', 'b');
    expect(releaseBusyOpenedBefore(Date.now() + 1)).toBe(2);
    expect(openBusyItems()).toHaveLength(0);
  });

  it('el dueño no se escribe en ocupada.json (lo lee otro proceso)', () => {
    const src = readFileSync('src/ocupada.ts', 'utf8');
    expect(src).toMatch(/new WeakMap<BusyItem, string>/);
  });

  it('el daemon marca cada hilo con su chat y /stop pasa el suyo', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(/thread\.agent\.busyOwner = chatKey_;/);
    expect(cli).toMatch(/releaseBusyOpenedBefore\(stopAt, chatKey_\)/);
    const agent = readFileSync('src/core/agent.ts', 'utf8');
    expect(agent).toMatch(/busyBegin\('turnos', .*this\.busyOwner\)/);
    expect(agent).toMatch(/busyBegin\('aprobaciones', 'permiso', this\.busyOwner\)/);
  });
});

// bugs-36 (revisión de gaps-15 #2367, «Grupos donde estoy» en /estado):
// - «hoy»/«ayer» contaba bloques de 24 h, así que un grupo que habló ayer a las 18:00 salía
//   «último mensaje hoy» hasta las 18:00 de hoy.
// - El «visto» solo se reescribía una vez al día (para no tocar el fichero con cada mensaje),
//   y el orden «del último en hablar» podía ir con un día de retraso.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatTitulos } from '../src/chat-titulos.js';
import { gruposEstado } from '../src/status.js';

describe('/estado: cuándo habló cada grupo', () => {
  let dir = '';
  let prevTz: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-bugs36-titulos-'));
    prevTz = process.env.PA_TIMEZONE;
    process.env.PA_TIMEZONE = 'Europe/Madrid';
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevTz === undefined) delete process.env.PA_TIMEZONE;
    else process.env.PA_TIMEZONE = prevTz;
  });

  it('por días de calendario: ayer a las 19:00 es «ayer» aunque no hayan pasado 24 h', () => {
    const now = Date.parse('2026-11-11T10:00:00+01:00');
    expect(
      gruposEstado(
        [
          { titulo: 'Familia', visto: Date.parse('2026-11-11T08:30:00+01:00') },
          { titulo: 'Pádel', visto: Date.parse('2026-11-10T19:00:00+01:00') },
          { titulo: 'Inversores', visto: Date.parse('2026-11-08T23:30:00+01:00') },
        ],
        now,
      ),
    ).toEqual([
      '«Familia» (último mensaje hoy)',
      '«Pádel» (último mensaje ayer)',
      '«Inversores» (último mensaje hace 3 días)',
    ]);
  });

  it('el orden es del último en hablar, aunque el fichero no se reescriba', () => {
    let now = Date.parse('2026-11-10T09:00:00Z');
    const t = new ChatTitulos(join(dir, 'chat-titulos.json'), () => now);
    t.recordar('telegram:default:-100111', 'Familia');
    now = Date.parse('2026-11-10T10:00:00Z');
    t.recordar('telegram:default:-100222', 'Inversores');
    now = Date.parse('2026-11-11T08:00:00Z'); // Familia otra vez, 23 h después
    expect(t.recordar('telegram:default:-100111', 'Familia')).toBe(false);
    expect(t.lista().map((g) => g.titulo)).toEqual(['Familia', 'Inversores']);
  });
});

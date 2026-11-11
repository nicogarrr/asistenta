import { describe, expect, it } from 'vitest';
import { bibliotecaVista } from '../src/biblioteca.js';
import type { Creado } from '../src/creados.js';

// bugs-38: «Esta semana» en /biblioteca eran los últimos 7 días, así que un lunes lo del
// miércoles pasado salía en «Esta semana». Ahora es la semana de calendario (desde el lunes), y
// lo de ayer va en «Ayer» (un lunes, lo del domingo no se va a «Antes»).
const c = (id: string, nombre: string, creado: number): Creado => ({
  id,
  nombre,
  bytes: 1024,
  creado,
});
const grupos = (v: { text: string }) =>
  v.text
    .split('\n')
    .filter((l) => /^(?:📌 Fijados|Hoy|Ayer|Esta semana|Antes):$/.test(l) || /^\d+\. /.test(l))
    .map((l) => l.replace(/ · .*$/, ''));

describe('bugs-38: /biblioteca «Esta semana» es la semana de calendario', () => {
  it('un lunes: lo del domingo es «Ayer» y lo del miércoles pasado «Antes»', () => {
    // Lunes 16-nov-2026 10:00 en Madrid.
    const NOW = Date.UTC(2026, 10, 16, 9, 0);
    const v = bibliotecaVista(
      [
        c('20261116-090000-a-hoy.png', 'hoy.png', Date.UTC(2026, 10, 16, 8)),
        c('20261115-180000-b-domingo.pdf', 'domingo.pdf', Date.UTC(2026, 10, 15, 17)),
        c('20261111-120000-c-miercoles.pdf', 'miercoles.pdf', Date.UTC(2026, 10, 11, 11)),
      ],
      null,
      NOW,
    );
    expect(grupos(v)).toEqual([
      'Hoy:',
      '1. 🖼️ hoy.png',
      'Ayer:',
      '2. 📄 domingo.pdf',
      'Antes:',
      '3. 📄 miercoles.pdf',
    ]);
  });

  it('un miércoles: lo del lunes es «Esta semana»; lo del jueves pasado, «Antes»', () => {
    // Miércoles 11-nov-2026 17:00 en Madrid.
    const NOW = Date.UTC(2026, 10, 11, 16, 0);
    const v = bibliotecaVista(
      [
        c('20261111-150000-a-hoy.png', 'hoy.png', NOW - 3_600_000),
        c('20261109-090000-b-lunes.pdf', 'lunes.pdf', Date.UTC(2026, 10, 9, 8)),
        c('20261105-090000-c-jueves.pdf', 'jueves.pdf', Date.UTC(2026, 10, 5, 8)),
      ],
      null,
      NOW,
    );
    expect(grupos(v)).toEqual([
      'Hoy:',
      '1. 🖼️ hoy.png',
      'Esta semana:',
      '2. 📄 lunes.pdf',
      'Antes:',
      '3. 📄 jueves.pdf',
    ]);
  });
});

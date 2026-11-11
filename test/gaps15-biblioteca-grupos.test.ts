import { describe, expect, it } from 'vitest';
import { bibliotecaVista } from '../src/biblioteca.js';
import type { Creado } from '../src/creados.js';

// 11-nov-2026 17:00 en Madrid.
const NOW = Date.UTC(2026, 10, 11, 16, 0);
const H = 3_600_000;
const c = (id: string, nombre: string, creado: number): Creado => ({
  id,
  nombre,
  bytes: 1024,
  creado,
});

describe('gaps-15: /biblioteca agrupa en «Hoy / Esta semana / Antes» (Grok Bot Library)', () => {
  it('con varios grupos, un título por grupo y la numeración de siempre', () => {
    const lista = [
      c('20261111-160000-a-hoy.png', 'hoy.png', NOW - 2 * H),
      // Ayer a las 23:30 en Madrid: es «Ayer», no «Hoy», aunque sean menos de 24 h.
      c('20261110-223000-b-ayer.xlsx', 'ayer.xlsx', Date.UTC(2026, 10, 10, 22, 30)),
      // El lunes de esta semana (el 11 es miércoles; bugs-38: semana de calendario).
      c('20261109-090000-c-semana.pdf', 'semana.pdf', Date.UTC(2026, 10, 9, 9)),
      c('20261020-090000-d-viejo.pdf', 'viejo.pdf', Date.UTC(2026, 9, 20, 9)),
      c('20261001-090000-e-fijo.pdf', 'fijo.pdf', Date.UTC(2026, 9, 1, 9)),
    ];
    const v = bibliotecaVista(lista, null, NOW, new Set(['20261001-090000-e-fijo.pdf']));
    const lines = v.text.split('\n');
    const desde = lines.indexOf('📌 Fijados:');
    expect(lines.slice(desde, desde + 10).map((l) => l.replace(/ · .*$/, ''))).toEqual([
      '📌 Fijados:',
      '1. 📌 📄 fijo.pdf',
      'Hoy:',
      '2. 🖼️ hoy.png',
      'Ayer:',
      '3. 📊 ayer.xlsx',
      'Esta semana:',
      '4. 📄 semana.pdf',
      'Antes:',
      '5. 📄 viejo.pdf',
    ]);
    expect(v.sends.map((s) => s.label)).toEqual(['📤 1', '📤 2', '📤 3', '📤 4', '📤 5']);
  });

  it('todo del mismo grupo: sin títulos (como antes)', () => {
    const v = bibliotecaVista(
      [
        c('20261111-150000-a-x.png', 'x.png', NOW - H),
        c('20261111-140000-b-y.png', 'y.png', NOW - 2 * H),
      ],
      null,
      NOW,
    );
    expect(v.text).not.toMatch(/^(Hoy|Ayer|Esta semana|Antes):$/m);
  });
});

import { describe, expect, it } from 'vitest';
import { enlacesDe } from '../src/enlaces-enviados.js';

// bugs-36 (revisión de gaps-14 #2360, «/biblioteca enlaces»): el patrón de URL cortaba en el
// primer «)», así que un enlace de Wikipedia salía roto (…/Mises_(economista sin cerrar: una
// página que no existe), y el filtro de «internos» dejaba pasar el panel por la IP de
// Tailscale (100.x) y la red de casa 172.16–31.x.

const at = Date.parse('2026-11-11T17:00:00+01:00');

describe('/biblioteca enlaces: URLs con paréntesis e internos', () => {
  it('un enlace con paréntesis sale entero, también dentro de Markdown o entre paréntesis', () => {
    const urls = enlacesDe([
      {
        at,
        text: [
          'Mira https://es.wikipedia.org/wiki/Ludwig_von_Mises_(economista).',
          'Y [la escuela](https://es.wikipedia.org/wiki/Escuela_austr%C3%ADaca_(econom%C3%ADa)) también.',
          '(más en https://www.expansion.com/mercados/x.html)',
          'El [informe](https://ir.example.com/asts-q3.pdf) de ASTS',
        ].join('\n'),
      },
    ]).map((e) => e.url);
    expect(urls).toEqual([
      'https://es.wikipedia.org/wiki/Ludwig_von_Mises_(economista)',
      'https://es.wikipedia.org/wiki/Escuela_austr%C3%ADaca_(econom%C3%ADa)',
      'https://www.expansion.com/mercados/x.html',
      'https://ir.example.com/asts-q3.pdf',
    ]);
  });

  it('la etiqueta Markdown se sigue leyendo', () => {
    const [e] = enlacesDe([{ at, text: 'El [informe de ASTS](https://ir.example.com/a.pdf)' }]);
    expect(e?.etiqueta).toBe('informe de ASTS');
  });

  it('el panel por Tailscale (100.x) o por la red de casa (172.16–31.x) no es «algo que te mandé»', () => {
    const urls = enlacesDe([
      {
        at,
        text: 'Panel: http://100.101.12.7:7357/ y http://172.20.0.5:7357/ · noticia https://www.expansion.com/a.html · otra http://100.200.1.1/x',
      },
    ]).map((e) => e.url);
    expect(urls).toEqual(['https://www.expansion.com/a.html', 'http://100.200.1.1/x']);
  });
});

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { bibliotecaOrden } from '../src/biblioteca.js';
import { usableButtons } from '../src/channels/telegram.js';
import { enlacesDe, enlacesVista } from '../src/enlaces-enviados.js';
import { SessionStore } from '../src/memory/sessions.js';

const TZ = 'Europe/Madrid';
const now = Date.parse('2026-11-11T17:00:00+01:00');

describe('gaps-14: «/biblioteca enlaces» (Grok Bot, Library → Links)', () => {
  it('lee las respuestas de ESTE chat, lo más nuevo primero, sin las de otros ni las del dueño', () => {
    const db = new DatabaseSync(':memory:');
    const s = new SessionStore({ db });
    const a = s.begin('telegram:default:42', 'pisos');
    s.addTurn(a, 'user', 'mira https://mio.example/no-cuenta');
    s.addTurn(a, 'assistant', 'El piso: https://www.idealista.com/inmueble/123/');
    const b = s.begin('telegram:default:-100', 'grupo');
    s.addTurn(b, 'assistant', 'De otro chat: https://otro.example/x');
    const turnos = s.recentAssistantTurns('telegram:default:42');
    expect(turnos.map((t) => t.text)).toEqual(['El piso: https://www.idealista.com/inmueble/123/']);
    expect(enlacesDe(turnos).map((e) => e.url)).toEqual([
      'https://www.idealista.com/inmueble/123/',
    ]);
  });

  it('saca la etiqueta (Markdown o la línea), quita la puntuación final, repetidos e internos', () => {
    const turnos = [
      {
        at: now - 60_000,
        text: [
          'Te dejo [El informe de ASTS](https://ir.example.com/asts-q3.pdf) y',
          'la noticia: https://www.expansion.com/mercados/x.html.',
          'Panel: http://127.0.0.1:7357/ y https://pc.tail1234.ts.net/panel',
        ].join('\n'),
      },
      {
        at: now - 2 * 86_400_000,
        text: 'Ya te la pasé: https://www.expansion.com/mercados/x.html?utm_source=tw',
      },
    ];
    const e = enlacesDe(turnos);
    expect(e.map((x) => x.url)).toEqual([
      'https://ir.example.com/asts-q3.pdf',
      'https://www.expansion.com/mercados/x.html',
    ]);
    expect(e[0]?.etiqueta).toBe('El informe de ASTS');
    expect(e[1]?.etiqueta).toBe('la noticia');
    expect(e[1]?.at).toBe(now - 60_000);
  });

  it('la vista: una línea por enlace y un botón «🔗 N» que Telegram acepta', () => {
    const v = enlacesVista(
      [
        {
          url: 'https://ir.example.com/asts-q3.pdf',
          etiqueta: 'El informe de ASTS',
          at: now - 60_000,
        },
        { url: 'http://viejo.example/a', etiqueta: '', at: now - 3 * 86_400_000 },
      ],
      now,
      TZ,
    );
    expect(v.text).toContain('1. El informe de ASTS — ir.example.com · hoy 16:59');
    expect(v.text).toContain('2. viejo.example · 8 nov');
    // http:// no vale como botón-enlace: sale en el texto, sin botón.
    expect(v.buttons).toEqual([
      { label: '🔗 1', action: 'url:https://ir.example.com/asts-q3.pdf' },
    ]);
    expect(usableButtons(v.buttons)).toHaveLength(1);
    expect(enlacesVista([], now, TZ).text).toContain('Aún no te he mandado ningún enlace');
  });

  it('como mucho 10', () => {
    const turnos = [
      { at: now, text: Array.from({ length: 14 }, (_, i) => `https://e${i}.example/`).join(' ') },
    ];
    expect(enlacesDe(turnos)).toHaveLength(10);
  });

  it('«/biblioteca enlaces» (y links) es la orden; «enlace raro» es una búsqueda', () => {
    expect(bibliotecaOrden('enlaces')).toEqual({ kind: 'enlaces' });
    expect(bibliotecaOrden('links')).toEqual({ kind: 'enlaces' });
    expect(bibliotecaOrden('mis enlaces')).toEqual({ kind: 'enlaces' });
    expect(bibliotecaOrden('enlace raro')).toMatchObject({ kind: 'lista', busca: 'enlace raro' });
  });
});

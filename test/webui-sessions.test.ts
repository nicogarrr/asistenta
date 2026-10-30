import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { resumenSesion } from '../src/webui/client-format.js';
import { renderFormatScript, renderPage } from '../src/webui/page.js';

// CI y el PC de Nico van en Europe/Madrid; las horas se leen en hora local.
const ahora = new Date(2026, 9, 30, 14, 0).getTime();

describe('panel: sesiones legibles', () => {
  it('una sesión reciente (Session) enseña cuándo, dónde y el resumen', () => {
    const r = resumenSesion(
      {
        id: 's1',
        scope: 'telegram:dm:12345#main',
        title: 'Cita del DNI',
        startedAt: new Date(2026, 9, 30, 9, 5).getTime(),
        endedAt: new Date(2026, 9, 30, 9, 40).getTime(),
        summary: 'Buscamos cita en Retiro; hay huecos el 12 y el 14.',
      },
      0,
      ahora,
    );
    expect(r).toEqual({
      titulo: 'Cita del DNI',
      meta: 'Hoy, 09:05 · Telegram',
      extracto: 'Buscamos cita en Retiro; hay huecos el 12 y el 14.',
    });
  });

  it('marca la sesión abierta como «en curso» y distingue ayer y otros días', () => {
    const ayer = new Date(2026, 9, 29, 23, 30).getTime();
    expect(
      resumenSesion({ title: 'x', scope: 'panel', startedAt: ayer, endedAt: null }, 0, ahora).meta,
    ).toBe('Ayer, 23:30 · en curso · Panel');
    expect(
      resumenSesion({ title: 'x', startedAt: new Date(2026, 6, 4, 8, 0).getTime() }, 0, ahora).meta,
    ).toBe('04/07, 08:00');
    expect(
      resumenSesion({ title: 'x', startedAt: new Date(2025, 11, 31, 18, 0).getTime() }, 0, ahora)
        .meta,
    ).toBe('31/12/2025, 18:00');
  });

  it('un resultado de búsqueda (SessionHit) enseña el fragmento que coincide', () => {
    const r = resumenSesion(
      {
        sessionId: 's2',
        title: 'Vuelos',
        summary: 'resumen',
        snippet: '…el de las 7:40…',
        at: ahora - 60_000,
      },
      0,
      ahora,
    );
    expect(r.extracto).toBe('…el de las 7:40…');
    expect(r.meta).toBe('Hoy, 13:59');
  });

  it('sin título no enseña el id interno, y recorta extractos largos', () => {
    const r = resumenSesion({ id: '01HZX9', summary: 'a'.repeat(400) }, 2, ahora);
    expect(r.titulo).toBe('Conversación 3');
    expect(r.extracto.length).toBeLessThanOrEqual(218);
    expect(r.extracto.endsWith('…')).toBe(true);
    expect(resumenSesion(null, 0, ahora)).toEqual({
      titulo: 'Conversación 1',
      meta: '',
      extracto: '',
    });
  });

  it('la página usa el resumen y la copia del navegador coincide', () => {
    expect(renderPage()).toContain('formato.resumenSesion(sesion, i, Date.now())');
    const ctx: { asistentaFormato?: { resumenSesion: typeof resumenSesion } } = {};
    runInNewContext(
      renderFormatScript().replace('var asistentaFormato', 'this.asistentaFormato'),
      ctx,
    );
    expect(ctx.asistentaFormato?.resumenSesion({ title: 'T', scope: 'cli' }, 0, ahora)).toEqual({
      titulo: 'T',
      meta: 'Terminal',
      extracto: '',
    });
  });
});

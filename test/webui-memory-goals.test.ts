import { describe, expect, it } from 'vitest';
import { formatearCampo, progresoPlan, resumenMemoria } from '../src/webui/client-format.js';
import { renderPage } from '../src/webui/page.js';

const entradas = [
  {
    id: 'm1',
    date: '2026-10-25',
    text: 'Prefiere pasillo.',
    tags: ['viajes'],
    supersedes: [],
    supersededBy: null,
  },
  {
    id: 'm0',
    date: '2026-09-02',
    text: 'Gestoría antigua.',
    tags: [],
    supersedes: [],
    supersededBy: 'm2',
  },
  {
    id: 'm2',
    date: '2026-10-28',
    text: 'Gestoría nueva.',
    tags: ['impuestos', 'trimestres'],
    supersedes: ['m0'],
    supersededBy: null,
  },
];

describe('panel: memoria y objetivos legibles', () => {
  it('separa lo vigente de lo sustituido y muestra fecha y etiquetas', () => {
    const r = resumenMemoria(entradas);
    expect(r?.vigentes).toEqual([
      { texto: 'Prefiere pasillo.', meta: '25/10/2026 · #viajes' },
      { texto: 'Gestoría nueva.', meta: '28/10/2026 · #impuestos #trimestres' },
    ]);
    expect(r?.sustituidas).toEqual([{ texto: 'Gestoría antigua.', meta: '02/09/2026' }]);
    expect(resumenMemoria({ scope: 'local', entries: entradas })?.vigentes).toHaveLength(2);
    expect(resumenMemoria([])).toEqual({ vigentes: [], sustituidas: [] });
  });

  it('cae a la vista genérica si los datos no son memoria', () => {
    expect(resumenMemoria({ ok: true })).toBeNull();
    expect(resumenMemoria([{ foo: 1 }])).toBeNull();
    expect(resumenMemoria('x')).toBeNull();
  });

  it('una fecha sin hora es un día: sin «0:00» y sin saltar al día anterior', () => {
    expect(formatearCampo('date', '2026-10-25', 'America/New_York')).toBe('25 oct 2026');
    expect(formatearCampo('date', '2026-10-25', 'Europe/Madrid')).toBe('25 oct 2026');
  });

  it('resume el progreso del plan', () => {
    expect(progresoPlan([{ done: true }, { done: false }, { done: false }])).toBe(
      '1 de 3 pasos hechos',
    );
    expect(progresoPlan([{ done: true }])).toBe('1 de 1 paso hecho');
    expect(progresoPlan([])).toBe('');
    expect(progresoPlan(null)).toBe('');
  });

  it('la página usa las vistas nuevas y una copia clara en Objetivos', () => {
    const html = renderPage();
    expect(html).toContain('formato.resumenMemoria(datos)');
    expect(html).toContain('formato.progresoPlan(objetivo.plan)');
    expect(html).toContain('para cambiar un objetivo, pídelo en el chat o en Telegram');
    expect(html).not.toContain('Estados reales del objetivo; no conceden permisos');
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(m[1] ?? '')).not.toThrow();
    }
  });
});

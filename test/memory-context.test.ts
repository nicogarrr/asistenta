// Item 9b (indice de memoria en la nota de contexto): tests escritos ANTES de
// la implementacion (TDD). La nota deja de volcar las ultimas 20 crudas
// (incluidas superadas) y pasa a indice hibrido: ultimas 5 completas + resto
// como indice [id] (fecha) #tags snippet80, con cap de chars y recuento
// declarado. El detalle completo ya existe via memory action=recall/list.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEMORY_CONTEXT_CAP, renderMemoryContext } from '../src/memory/context.js';
import { MemoryStore } from '../src/memory.js';

function seededStore() {
  return new MemoryStore(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'ctx-')));
}

const SCOPE = 'ctx:test#main';
const LONG = 'x'.repeat(200);

describe('9b: renderMemoryContext (indice hibrido para buildContextNote)', () => {
  it('sin memoria no hay seccion (null, no texto vacio)', () => {
    expect(renderMemoryContext([])).toBeNull();
  });

  it('NEGATIVO: una superada NUNCA aparece, ni siendo la mas reciente', () => {
    const store = seededStore();
    store.remember(SCOPE, 'prefiero respuestas cortas', { tags: ['lang'] });
    const vieja = store.remember(SCOPE, 'levanto 52 kg en press banca', { tags: ['gym'] });
    store.remember(SCOPE, 'levanto 53 kg en press banca', {
      tags: ['gym'],
      supersedes: [vieja.id],
    });
    const r = renderMemoryContext(store.all(SCOPE));
    expect(r).not.toBeNull();
    expect(r?.body).not.toContain('52 kg');
    expect(r?.body).toContain('53 kg');
    expect(r?.active).toBe(2);
    expect(r?.superseded).toBe(1);
  });

  it('el recuento declarado en cabecera coincide con el store', () => {
    const store = seededStore();
    const a = store.remember(SCOPE, 'dato uno');
    store.remember(SCOPE, 'dato dos');
    store.remember(SCOPE, 'dato uno corregido', { supersedes: [a.id] });
    const r = renderMemoryContext(store.all(SCOPE));
    expect(r?.body).toContain('2 activas');
    expect(r?.body).toContain('1 superadas ocultas');
    expect(r?.body).toContain('memory action=recall');
  });

  it('las 5 mas recientes van COMPLETAS; las antiguas solo snippet de 80 chars', () => {
    const store = seededStore();
    for (let i = 1; i <= 8; i++) store.remember(SCOPE, `entrada ${i} ${LONG}`);
    const r = renderMemoryContext(store.all(SCOPE));
    const body = r?.body ?? '';
    // Las 5 recientes conservan el texto entero (200 x).
    for (const i of [4, 5, 6, 7, 8]) expect(body).toContain(`entrada ${i} ${LONG}`);
    // Las 3 antiguas van como indice: snippet de 80 + elipsis, texto entero ausente.
    for (const i of [1, 2, 3]) {
      expect(body).not.toContain(`entrada ${i} ${LONG}`);
      expect(body).toContain(`entrada ${i} ${'x'.repeat(70)}`);
    }
  });

  it('linea de indice: [id] (fecha) #tags y snippet<=80 con elipsis', () => {
    const store = seededStore();
    store.remember(SCOPE, `hecho antiguo ${LONG}`, { tags: ['banco'] });
    for (let i = 0; i < 5; i++) store.remember(SCOPE, `relleno ${i}`);
    const r = renderMemoryContext(store.all(SCOPE));
    expect(r?.body).not.toContain(LONG);
    const idxLine = (r?.body ?? '').split('\n').find((l) => l.includes('#banco'));
    expect(idxLine).toMatch(/^- \[[a-z0-9]+\] \(\d{4}-\d{2}-\d{2}\) #banco hecho antiguo x+…$/);
  });

  it('CAP: el cuerpo nunca supera el cap y la cola declara las ocultas', () => {
    const store = seededStore();
    for (let i = 1; i <= 120; i++) store.remember(SCOPE, `factura ${i}: ${LONG}${LONG}`);
    const r = renderMemoryContext(store.all(SCOPE));
    expect(r).not.toBeNull();
    expect((r?.body ?? '').length).toBeLessThanOrEqual(MEMORY_CONTEXT_CAP);
    expect(r?.hiddenByCap).toBeGreaterThan(0);
    expect(r?.body).toContain(`y ${r?.hiddenByCap} más`);
    expect(r?.body).toContain('memory action=list');
    // La mas reciente siempre sobrevive al recorte.
    expect(r?.body).toContain('factura 120');
  });

  it('con <=5 activas todo va completo y no hay lineas de indice', () => {
    const store = seededStore();
    store.remember(SCOPE, `unica ${LONG}`);
    const r = renderMemoryContext(store.all(SCOPE));
    expect(r?.body).toContain(`unica ${LONG}`);
    expect(r?.body).not.toContain('…');
    expect(r?.hiddenByCap).toBe(0);
  });

  it('todas superadas: seccion honesta con 0 activas, sin texto de superadas', () => {
    const store = seededStore();
    const a = store.remember(SCOPE, 'dato caducado');
    store.remember(SCOPE, 'dato vigente', { supersedes: [a.id] });
    const soloSuperada = store.all(SCOPE).filter((e) => e.id === a.id);
    const r = renderMemoryContext(soloSuperada);
    expect(r).not.toBeNull();
    expect(r?.active).toBe(0);
    expect(r?.body).toContain('0 activas');
    expect(r?.body).not.toContain('dato caducado');
  });
});

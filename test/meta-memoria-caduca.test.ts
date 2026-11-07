import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractionPrompt, parseExtractedFacts, splitCaducidad } from '../src/core/history.js';
import { envSwitchOn } from '../src/env-flags.js';
import { renderMemoryContext } from '../src/memory/context.js';
import { MemoryStore, parseMemory, serializeMemory } from '../src/memory.js';

/**
 * Active Memory (lane meta-modelos-1, idea del artículo de Meta del 6-nov-2026): lo
 * temporal se guarda con su último día y, pasado, deja de entrar en el contexto
 * (sin borrarse). Lo permanente sigue igual.
 */
const dir = mkdtempSync(join(tmpdir(), 'pa-caduca-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('memoria con caducidad', () => {
  it('el fichero guarda y relee «caduca: AAAA-MM-DD»', () => {
    const store = new MemoryStore(join(dir, 'a'));
    const e = store.remember('chat', 'Nico está en Sevilla esta semana', { caduca: '2026-11-08' });
    expect(e.caduca).toBe('2026-11-08');
    const raw = readFileSync(store.fileFor('chat'), 'utf8');
    expect(raw).toContain('caduca: 2026-11-08');
    expect(store.all('chat')[0]?.caduca).toBe('2026-11-08');
    const doc = parseMemory(raw);
    expect(parseMemory(serializeMemory(doc)).entries[0]?.caduca).toBe('2026-11-08');
  });

  it('una fecha mal escrita se rechaza en vez de guardar basura', () => {
    const store = new MemoryStore(join(dir, 'b'));
    expect(() => store.remember('chat', 'x', { caduca: 'el domingo' })).toThrow(/YYYY-MM-DD/);
  });

  it('el contexto oculta lo caducado, enseña la fecha de lo vigente y no toca lo permanente', () => {
    const store = new MemoryStore(join(dir, 'c'));
    store.remember('chat', 'Le gusta el café solo');
    store.remember('chat', 'Está en Sevilla hasta el domingo', { caduca: '2026-11-08' });
    store.remember('chat', 'Su madre viene el lunes', { caduca: '2026-11-10' });
    const entries = store.all('chat');
    const antes = renderMemoryContext(entries, '2026-11-07');
    expect(antes?.body).toContain('Sevilla');
    expect(antes?.body).toContain('(vale hasta 2026-11-08)');
    const despues = renderMemoryContext(entries, '2026-11-09');
    expect(despues?.body).not.toContain('Sevilla');
    expect(despues?.body).toContain('café solo');
    expect(despues?.body).toContain('Su madre viene el lunes');
    expect(despues?.body).toContain('1 caducadas ocultas');
    expect(despues?.active).toBe(2);
    // El día exacto todavía vale.
    expect(renderMemoryContext(entries, '2026-11-08')?.body).toContain('Sevilla');
  });

  it('el extractor separa el sufijo de caducidad', () => {
    expect(splitCaducidad('Está en Sevilla (caduca: 2026-11-08)')).toEqual({
      text: 'Está en Sevilla',
      caduca: '2026-11-08',
    });
    expect(splitCaducidad('Le gusta el café')).toEqual({ text: 'Le gusta el café' });
    expect(splitCaducidad('Raro (caduca: 2026-13-45)')).toEqual({
      text: 'Raro (caduca: 2026-13-45)',
    });
    // El tope de 240 es del hecho, no del sufijo.
    const largo = `${'a'.repeat(235)} (caduca: 2026-11-08)`;
    expect(parseExtractedFacts(JSON.stringify([largo]))).toEqual([largo]);
  });

  it('PA_MEMORIA_CADUCA: apagada por defecto; encendida, el prompt pide lo temporal con fecha', () => {
    expect(envSwitchOn('PA_MEMORIA_CADUCA', {})).toBe(false);
    expect(envSwitchOn('PA_MEMORIA_CADUCA', { PA_MEMORIA_CADUCA: 'sí' })).toBe(true);
    const sin = extractionPrompt({ transcript: 'x', existingFacts: [] });
    expect(sin).toContain('NO extraigas: estado transitorio');
    const con = extractionPrompt({ transcript: 'x', existingFacts: [], hoy: '2026-11-07' });
    expect(con).toContain('Hoy es 2026-11-07');
    expect(con).toContain('(caduca: AAAA-MM-DD)');
    expect(con).not.toContain('NO extraigas: estado transitorio');
  });
});

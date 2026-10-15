// Item 9b ronda 2 (auditor #136): el drill-down que el indice del contexto
// promete no puede reintroducir hechos sustituidos. End-to-end sobre el MISMO
// store: buildContextNote (lo que el modelo ve cada turno) y la tool memory
// (lo que el modelo consulta) nunca muestran una superada como vigente.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContextNote } from '../src/cli.js';
import { Store } from '../src/db.js';
import { MemoryStore } from '../src/memory.js';
import { createMemoryTool } from '../src/tools/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE = 'drill:test#main';

let dir = '';
let store: Store;
let memory: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'drill-'));
  store = new Store(join(dir, 'db.sqlite'));
  memory = new MemoryStore(join(dir, 'memory'));
});

afterEach(() => {
  store.close();
});

function textOf(result: { content: Array<{ type: string; text?: string } | unknown> }): string {
  return result.content
    .map((c) => (typeof c === 'object' && c && 'text' in c ? String(c.text) : ''))
    .join('\n');
}

function correctedPair() {
  const vieja = memory.remember(SCOPE, 'levanto 52 kg en press banca', { tags: ['gym'] });
  const nueva = memory.remember(SCOPE, 'levanto 53 kg en press banca', {
    tags: ['gym'],
    supersedes: [vieja.id],
  });
  return { vieja, nueva };
}

describe('9b r2: drill-down sin hechos sustituidos (auditor #136)', () => {
  it('E2E correccion 52->53: contexto solo 53 y ningun camino muestra 52 como vigente', async () => {
    const { vieja, nueva } = correctedPair();
    const tool = createMemoryTool(memory, () => SCOPE);

    // 1) Lo que el modelo ve cada turno: buildContextNote real, no el renderer aislado.
    const note = buildContextNote({ key: SCOPE, name: 'main' }, store, memory);
    expect(note).toContain('53 kg');
    expect(note).not.toContain('52 kg');

    // 2) Drill-down por defecto: list y recall sin query solo muestran vigentes.
    const list = await tool.execute('c1', { action: 'list' });
    expect(textOf(list)).toContain('53 kg');
    expect(textOf(list)).not.toContain('52 kg');
    const recallVacio = await tool.execute('c2', { action: 'recall' });
    expect(textOf(recallVacio)).toContain('53 kg');
    expect(textOf(recallVacio)).not.toContain('52 kg');

    // 3) Lookup exacto por id (sin ranking lexical): la vigente sale entera...
    const getNueva = await tool.execute('c3', { action: 'get', id: nueva.id });
    expect(textOf(getNueva)).toContain('53 kg');
    expect(textOf(getNueva)).not.toContain('SUSTITUIDA');
    // ...y la sustituida sale MARCADA y enlazada a su reemplazo, nunca vigente.
    const getVieja = await tool.execute('c4', { action: 'get', id: vieja.id });
    expect(textOf(getVieja)).toContain('SUSTITUIDA');
    expect(textOf(getVieja)).toContain(nueva.id);

    // 4) La historia existe solo si se pide: marcada y enlazada.
    const historia = await tool.execute('c5', { action: 'list', include_superseded: true });
    expect(textOf(historia)).toContain('52 kg');
    expect(textOf(historia)).toContain(`SUSTITUIDA por [${nueva.id}]`);

    // 5) recall con query sigue sin devolver superadas ni pidiendolo.
    const recallQuery = await tool.execute('c6', {
      action: 'recall',
      query: 'press banca',
      include_superseded: true,
    });
    expect(textOf(recallQuery)).toContain('53 kg');
    expect(textOf(recallQuery)).not.toContain('52 kg');
  });

  it('get con id desconocido lo dice, no inventa', async () => {
    const tool = createMemoryTool(memory, () => SCOPE);
    const r = await tool.execute('c7', { action: 'get', id: 'noexiste' });
    expect(textOf(r)).toContain('No hay nada con id noexiste');
    expect(r.details).toMatchObject({ found: false });
  });

  it('vacio se distingue de todo-sustituido', async () => {
    const tool = createMemoryTool(memory, () => SCOPE);
    const vacio = await tool.execute('c8', { action: 'list' });
    expect(textOf(vacio)).toContain('no tiene memoria guardada');

    correctedPair();
    const vigente = memory.all(SCOPE).find((e) => e.supersededBy === null);
    memory.forget(SCOPE, vigente?.id ?? '');
    const todas = await tool.execute('c9', { action: 'list' });
    expect(textOf(todas)).toContain('No queda nada vigente');
    const historia = await tool.execute('c10', { action: 'list', include_superseded: true });
    expect(textOf(historia)).toContain('SUSTITUIDA');
  });
});

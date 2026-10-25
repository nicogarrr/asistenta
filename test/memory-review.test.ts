/**
 * Cola de contradicciones y guardas que protegen la consolidacion: polaridad,
 * cadencia diaria y umbral semantico. El embedder es siempre un fake; el modelo
 * local se verifica en el PC, no en CI.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

import {
  consolidationDue,
  groupDuplicates,
  isPolarityConflict,
  lexicalDuplicate,
  shouldConsolidateDaily,
} from '../src/memory/consolidate.js';
import {
  append,
  CONTRADICTION_OVERLAP,
  clear,
  isContradiction,
  list,
  REVIEW_MAX_ITEMS,
  resolve,
} from '../src/memory/review.js';
import {
  clearEmbedCache,
  type Embedder,
  hybridRank,
  SEMANTIC_MIN_COSINE,
} from '../src/memory/semantic.js';

let dir = '';
let queuePath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-review-'));
  queuePath = join(dir, 'contradicciones.json');
  clearEmbedCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const entry = (id: string, text: string, date = '2026-10-01') => ({
  id,
  text,
  date,
  tags: [] as string[],
  supersedes: [] as string[],
  supersededBy: null as string | null,
});

function fakeEmbedder(map: Record<string, number[]>): Embedder {
  return {
    embed: async (texts) =>
      texts.map((text) => {
        const vector = map[text];
        if (!vector) throw new Error(`texto inesperado: ${text}`);
        return vector;
      }),
  };
}

describe('isContradiction', () => {
  it('detecta negacion del mismo predicado', () => {
    expect(isContradiction('vive en Madrid', 'no vive en Madrid')).toBe(true);
    expect(isContradiction('come carne', 'nunca come carne')).toBe(true);
    expect(isContradiction('jamás bebe alcohol', 'bebe alcohol')).toBe(true);
    expect(isContradiction('le gusta el café con leche', 'no le gusta el cafe con leche')).toBe(
      true,
    );
  });

  it('no confunde la misma polaridad ni textos sin relacion', () => {
    expect(isContradiction('no vive en Madrid', 'nunca vive en Madrid')).toBe(false);
    expect(isContradiction('vive en Madrid', 'vive en Madrid')).toBe(false);
    expect(isContradiction('no vive en Madrid', 'le gusta el cafe')).toBe(false);
    expect(isContradiction('', 'no vive en Madrid')).toBe(false);
  });

  it('exige el solape lexico declarado', () => {
    expect(CONTRADICTION_OVERLAP).toBe(0.6);
    // "no vive en Madrid" y "vive en Barcelona" comparten solo 2 de 5 tokens.
    expect(isContradiction('no vive en Madrid', 'vive en Barcelona')).toBe(false);
  });
});

describe('cola de revision', () => {
  it('list tolera fichero ausente, vacio, roto o con forma inesperada', () => {
    expect(list(queuePath)).toEqual([]);
    writeFileSync(queuePath, '   ', 'utf8');
    expect(list(queuePath)).toEqual([]);
    writeFileSync(queuePath, '{roto', 'utf8');
    expect(list(queuePath)).toEqual([]);
    writeFileSync(queuePath, JSON.stringify({ no: 'es un array' }), 'utf8');
    expect(list(queuePath)).toEqual([]);
  });

  it('append persiste, genera id y conserva ids y nota opcionales', () => {
    const item = append(queuePath, {
      a: 'vive en Madrid',
      b: 'no vive en Madrid',
      aId: 'm1',
      bId: 'm2',
      note: 'corregir tras mudanza',
    });
    expect(item.id).toMatch(/^rv-/);
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(list(queuePath)).toEqual([item]);
    const raw = JSON.parse(readFileSync(queuePath, 'utf8')) as unknown;
    expect(Array.isArray(raw)).toBe(true);
    expect(raw).toEqual([item]);
  });

  it('append respeta un id explicito y ordena de mas antigua a mas nueva', () => {
    append(queuePath, { id: 'uno', a: 'hecho uno', b: 'no hecho uno' });
    append(queuePath, { id: 'dos', a: 'hecho dos', b: 'no hecho dos' });
    expect(list(queuePath).map((item) => item.id)).toEqual(['uno', 'dos']);
  });

  it('tope 100: al entrar una nueva sale la mas antigua', () => {
    for (let i = 0; i < REVIEW_MAX_ITEMS + 5; i++) {
      append(queuePath, { a: `hecho ${i}`, b: `no hecho ${i}` });
    }
    const items = list(queuePath);
    expect(items).toHaveLength(REVIEW_MAX_ITEMS);
    expect(items[0]?.a).toBe('hecho 5');
    expect(items.at(-1)?.a).toBe(`hecho ${REVIEW_MAX_ITEMS + 4}`);
  });

  it('resolve elimina solo la entrada pedida y exige keepId', () => {
    const uno = append(queuePath, { id: 'uno', a: 'vive en Madrid', b: 'no vive en Madrid' });
    append(queuePath, { id: 'dos', a: 'come carne', b: 'nunca come carne' });
    expect(resolve(queuePath, uno.id, 'm1')).toBe(true);
    expect(list(queuePath).map((item) => item.id)).toEqual(['dos']);
    expect(resolve(queuePath, uno.id, 'm1')).toBe(false);
    expect(resolve(queuePath, 'dos', '')).toBe(false);
    expect(list(queuePath)).toHaveLength(1);
  });

  it('clear vacia la cola y devuelve cuantas salieron', () => {
    append(queuePath, { a: 'a', b: 'no a' });
    append(queuePath, { a: 'b', b: 'no b' });
    expect(clear(queuePath)).toBe(2);
    expect(list(queuePath)).toEqual([]);
    expect(clear(queuePath)).toBe(0);
    expect(clear(join(dir, 'no-existe.json'))).toBe(0);
  });

  it('la escritura es atomica: no deja temporales y repara un JSON roto', () => {
    writeFileSync(queuePath, '{roto', 'utf8');
    append(queuePath, { a: 'vive en Madrid', b: 'no vive en Madrid' });
    expect(list(queuePath)).toHaveLength(1);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    clear(queuePath);
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('guarda de polaridad en la consolidacion', () => {
  it('no fusiona una afirmacion con su negacion', async () => {
    const items = [entry('a', 'vive en Madrid'), entry('b', 'no vive en Madrid')];
    expect(await groupDuplicates(items)).toEqual([]);
    expect(lexicalDuplicate('vive en Madrid', 'no vive en Madrid')).toBe(false);
  });

  it('reconoce nunca y jamás delante del predicado', () => {
    expect(isPolarityConflict('come carne', 'nunca come carne')).toBe(true);
    expect(isPolarityConflict('bebe alcohol', 'jamás bebe alcohol')).toBe(true);
    expect(isPolarityConflict('no come carne', 'no come carne')).toBe(false);
    expect(isPolarityConflict('come carne', 'bebe alcohol')).toBe(false);
  });

  it('la guarda manda sobre el coseno del embedder', async () => {
    const a = 'vive en Madrid';
    const b = 'no vive en Madrid';
    const emb = fakeEmbedder({ [a]: [1, 0], [b]: [1, 0] });
    expect(await groupDuplicates([entry('a', a), entry('b', b)], { embedder: emb })).toEqual([]);
  });

  it('los duplicados normales se siguen fusionando', async () => {
    const groups = await groupDuplicates([
      entry('a', 'vive en Madrid'),
      entry('b', 'Vive en madrid'),
    ]);
    expect(groups).toHaveLength(1);
  });
});

describe('cadencia diaria de consolidacion', () => {
  it('la ventana se abre a las 04:00 locales', () => {
    expect(shouldConsolidateDaily(new Date(2026, 9, 25, 3, 59, 59))).toBe(false);
    expect(shouldConsolidateDaily(new Date(2026, 9, 25, 4, 0, 0))).toBe(true);
    expect(shouldConsolidateDaily(new Date(2026, 9, 25, 23, 30))).toBe(true);
  });

  it('sin ejecucion previa corre al abrirse la ventana, nunca antes', () => {
    expect(consolidationDue(undefined, new Date(2026, 9, 25, 3, 59))).toBe(false);
    expect(consolidationDue(undefined, new Date(2026, 9, 25, 4, 0))).toBe(true);
  });

  it('una vez al dia: hoy no se repite, manana vuelve a tocar', () => {
    const ranToday = new Date(2026, 9, 25, 4, 1).getTime();
    expect(consolidationDue(ranToday, new Date(2026, 9, 25, 23, 0))).toBe(false);
    expect(consolidationDue(ranToday, new Date(2026, 9, 26, 3, 59))).toBe(false);
    expect(consolidationDue(ranToday, new Date(2026, 9, 26, 4, 0))).toBe(true);
  });

  it('una ejecucion de ayer no bloquea la ventana de hoy; NaN cuenta como nunca', () => {
    const yesterday = new Date(2026, 9, 24, 4, 30).getTime();
    expect(consolidationDue(yesterday, new Date(2026, 9, 25, 4, 0))).toBe(true);
    expect(consolidationDue(Number.NaN, new Date(2026, 9, 25, 4, 0))).toBe(true);
  });
});

describe('umbral minimo del recall semantico', () => {
  it('poda el candidato solo semantico por debajo del umbral y conserva el lexico', async () => {
    expect(SEMANTIC_MIN_COSINE).toBe(0.35);
    const query = 'consulta';
    const below = 'frase sin relacion';
    const above = 'parafrasis cercana';
    const exact = 'consulta exacta';
    const emb = fakeEmbedder({
      [query]: [1, 0],
      [below]: [0.2, Math.sqrt(1 - 0.2 ** 2)],
      [above]: [0.4, Math.sqrt(1 - 0.4 ** 2)],
      [exact]: [0, 1],
    });
    const hits = await hybridRank({
      query,
      items: [{ text: below }, { text: above }, { text: exact }],
      text: (item) => item.text,
      lexical: (item) => (item.text === exact ? 4 : 0),
      embedder: emb,
      limit: 10,
    });
    expect(hits.map((hit) => hit.text)).toEqual([exact, above]);
    expect(hits.map((hit) => hit.text)).not.toContain(below);
  });
});

/**
 * Consolidacion nocturna de memoria: agrupacion de duplicados, fusion con
 * supersedes (nada se borra) y copia recuperable previa. El embedder siempre
 * es un fake: el modelo local se verifica en el PC, no en CI.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSOLIDATE_TAG,
  consolidateProfile,
  consolidateScope,
  foldText,
  groupDuplicates,
  isConsolidationDue,
  lexicalDuplicate,
  runConsolidation,
  tokenJaccard,
} from '../src/memory/consolidate.js';
import type { Embedder } from '../src/memory/semantic.js';
import { ENTRY_SEPARATOR, MemorySnapshot } from '../src/memory/snapshot.js';
import { MemoryStore } from '../src/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

let dir = '';
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-consol-'));
  store = new MemoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fakeEmbedder(map: Record<string, number[]>): Embedder {
  return {
    embed: async (texts) =>
      texts.map((t) => {
        const v = map[t];
        if (!v) throw new Error(`texto inesperado: ${t}`);
        return v;
      }),
  };
}

const entry = (id: string, text: string, date = '2026-10-01') => ({
  id,
  text,
  date,
  tags: [] as string[],
  supersedes: [] as string[],
  supersededBy: null as string | null,
});

describe('isConsolidationDue', () => {
  it('fires from 03:00 local, never before, at most every 20h', () => {
    const night = new Date(2026, 9, 19, 3, 30);
    expect(isConsolidationDue(night, 0)).toBe(true);
    const evening = new Date(2026, 9, 19, 22, 0);
    expect(isConsolidationDue(evening, 0)).toBe(true);
    const early = new Date(2026, 9, 19, 2, 59);
    expect(isConsolidationDue(early, 0)).toBe(false);
    expect(isConsolidationDue(night, night.getTime() - 10 * 3_600_000)).toBe(false);
  });
});

describe('foldText / tokenJaccard / lexicalDuplicate', () => {
  it('folds accents, case and whitespace', () => {
    expect(foldText('  Le gusta el Café\n con  Leche ')).toBe('le gusta el cafe con leche');
  });

  it('jaccard is 1 for the same tokens and 0 for disjoint ones', () => {
    expect(tokenJaccard('prefiere respuestas en español', 'español en respuestas prefiere')).toBe(
      1,
    );
    expect(tokenJaccard('vive en madrid', 'trabaja en oviedo')).toBeLessThan(0.8);
  });

  it('catches identical-but-accented, contained and high-overlap duplicates', () => {
    expect(lexicalDuplicate('Le gusta el café con leche', 'le gusta el cafe con leche')).toBe(true);
    expect(
      lexicalDuplicate('prefiere el tren', 'prefiere el tren para viajes largos por España'),
    ).toBe(true);
    expect(
      lexicalDuplicate(
        'su cumpleaños es el 3 de mayo de 1999',
        'el cumpleaños es 3 de mayo de 1999, su',
      ),
    ).toBe(true);
    expect(lexicalDuplicate('vive en Madrid', 'odia el pescado crudo')).toBe(false);
    // Contención exige una longitud mínima: "tren" dentro de otra frase no basta.
    expect(lexicalDuplicate('si', 'siempre dice que si a todo')).toBe(false);
  });
});

describe('groupDuplicates', () => {
  it('groups transitive duplicates and keeps the newest, then longest, as canonical', async () => {
    const items = [
      entry('a', 'prefiere el tren para viajes largos', '2026-09-01'),
      entry('b', 'Prefiere el tren para viajes largos', '2026-09-15'),
      entry('c', 'prefiere el tren para viajes largos por España', '2026-09-15'),
      entry('d', 'odia el pescado crudo', '2026-09-02'),
    ];
    const groups = await groupDuplicates(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.canonical).toBe(2);
    expect(groups[0]?.absorbed.sort()).toEqual([0, 1]);
  });

  it('skips entries already superseded', async () => {
    const items = [
      { ...entry('a', 'vive en Madrid'), supersededBy: 'zz' },
      entry('b', 'vive en madrid'),
    ];
    expect(await groupDuplicates(items)).toHaveLength(0);
  });

  it('merges paraphrases by cosine when an embedder is given, not without one', async () => {
    const a = 'prefiere las respuestas en español';
    const b = 'quiere que le contesten siempre en castellano';
    const items = [entry('a', a), entry('b', b)];
    expect(await groupDuplicates(items)).toHaveLength(0);
    const emb = fakeEmbedder({ [a]: [1, 0], [b]: [0.99, 0.01] });
    const groups = await groupDuplicates(items, { embedder: emb });
    expect(groups).toHaveLength(1);
  });

  it('keeps paraphrases apart below the cosine threshold', async () => {
    const a = 'prefiere las respuestas en español';
    const b = 'odia el pescado crudo';
    const emb = fakeEmbedder({ [a]: [1, 0], [b]: [0, 1] });
    expect(await groupDuplicates([entry('a', a), entry('b', b)], { embedder: emb })).toHaveLength(
      0,
    );
  });

  it('falls back to lexical when the embedder throws', async () => {
    const broken: Embedder = { embed: async () => Promise.reject(new Error('sin modelo')) };
    const items = [entry('a', 'vive en Madrid'), entry('b', 'Vive en madrid')];
    const groups = await groupDuplicates(items, { embedder: broken });
    expect(groups).toHaveLength(1);
  });
});

describe('consolidateScope', () => {
  it('supersedes duplicates with one merged entry and deletes nothing', async () => {
    store.remember('chat:1', 'prefiere el tren para viajes largos');
    store.remember('chat:1', 'Prefiere el tren para viajes largos');
    store.remember('chat:1', 'odia el pescado crudo');
    const before = store.all('chat:1');
    const result = await consolidateScope(store, 'chat:1');
    expect(result.merged).toBe(2);
    expect(result.created).toBe(1);

    const after = store.all('chat:1');
    // Nada se borra: 3 originales + 1 fusionada.
    expect(after).toHaveLength(4);
    const absorbed = after.find((e) => e.id === before[0]?.id);
    expect(absorbed?.supersededBy).not.toBeNull();
    const merged = after.find((e) => e.tags.includes(CONSOLIDATE_TAG));
    expect(merged).toBeDefined();
    expect(merged?.text).toBe(before[0]?.text);
    expect(merged?.supersedes?.sort()).toEqual([before[0]?.id, before[1]?.id].sort());
    // El recall ya no devuelve la bala vieja.
    const hits = store.recall('chat:1', 'tren');
    expect(hits.map((h) => h.id)).toEqual([merged?.id]);
    // Y el hecho sin duplicar sigue intacto.
    expect(after.find((e) => e.text === 'odia el pescado crudo')?.supersededBy).toBeNull();
  });

  it('is a no-op on a scope without duplicates', async () => {
    store.remember('chat:2', 'vive en Madrid');
    store.remember('chat:2', 'odia el pescado crudo');
    const beforeText = store.read('chat:2');
    const result = await consolidateScope(store, 'chat:2');
    expect(result).toEqual({ scope: 'chat:2', merged: 0, created: 0 });
    expect(store.read('chat:2')).toBe(beforeText);
  });

  it('a second pass does not re-merge the consolidated entry', async () => {
    store.remember('chat:3', 'vive en Madrid');
    store.remember('chat:3', 'Vive en madrid');
    await consolidateScope(store, 'chat:3');
    const second = await consolidateScope(store, 'chat:3');
    expect(second.created).toBe(0);
  });
});

describe('consolidateProfile', () => {
  it('dedupes PERFIL.md through its public API and keeps the canonical text', async () => {
    const snap = new MemorySnapshot({ dir });
    expect(snap.appendEntry('trabaja en Savvy').ok).toBe(true);
    expect(snap.appendEntry('Trabaja en Savvy').ok).toBe(true);
    expect(snap.appendEntry('odia el pescado crudo').ok).toBe(true);
    const result = await consolidateProfile(snap);
    expect(result.appended).toBe(1);
    expect(result.removed).toBeGreaterThanOrEqual(1);
    const body = snap.load();
    const entries = body.split(ENTRY_SEPARATOR).filter((e) => e.trim());
    expect(entries.filter((e) => foldText(e) === 'trabaja en savvy')).toHaveLength(1);
    expect(body).toContain('odia el pescado crudo');
  });

  it('leaves a clean profile untouched', async () => {
    const snap = new MemorySnapshot({ dir });
    snap.appendEntry('trabaja en Savvy');
    snap.appendEntry('odia el pescado crudo');
    const before = snap.load();
    const result = await consolidateProfile(snap);
    expect(result).toEqual({ removed: 0, appended: 0 });
    expect(snap.load()).toBe(before);
  });
});

describe('runConsolidation', () => {
  it('backs up every file before modifying it and reports what it did', async () => {
    const snapDir = join(dir, 'snap');
    const backupDir = join(dir, 'consol-backups');
    const snap = new MemorySnapshot({ dir: snapDir });
    store.remember('chat:1', 'prefiere el tren para viajes largos');
    const originalFile = store.fileFor('chat:1');
    store.remember('chat:1', 'Prefiere el tren para viajes largos');
    snap.appendEntry('trabaja en Savvy');
    snap.appendEntry('Trabaja en Savvy');
    const originalPerfil = readFileSync(join(snapDir, 'PERFIL.md'), 'utf8');

    const report = await runConsolidation({
      store,
      snapshot: snap,
      backupDir,
      now: new Date(2026, 9, 19, 3, 5),
    });

    expect(report.scopes).toHaveLength(1);
    expect(report.scopes[0]?.created).toBe(1);
    expect(report.profile.appended).toBe(1);
    // Copia recuperable del scope y del perfil, con el contenido ORIGINAL.
    const scopeBackup = report.backups.find((p) => p.endsWith('.md') && !p.includes('PERFIL'));
    const perfilBackup = report.backups.find((p) => p.includes('PERFIL'));
    expect(scopeBackup).toBeDefined();
    expect(perfilBackup).toBeDefined();
    expect(readFileSync(scopeBackup ?? '', 'utf8')).not.toBe(readFileSync(originalFile, 'utf8'));
    expect(readFileSync(scopeBackup ?? '', 'utf8')).toContain(
      'prefiere el tren para viajes largos',
    );
    expect(readFileSync(perfilBackup ?? '', 'utf8')).toBe(originalPerfil);
    expect(existsSync(join(backupDir, '2026-10-19'))).toBe(true);
  });

  it('writes no backup and touches nothing when there are no duplicates', async () => {
    const snap = new MemorySnapshot({ dir: join(dir, 'snap') });
    store.remember('chat:1', 'vive en Madrid');
    store.remember('chat:1', 'odia el pescado crudo');
    const before = store.read('chat:1');
    const report = await runConsolidation({
      store,
      snapshot: snap,
      backupDir: join(dir, 'b'),
    });
    expect(report.scopes).toHaveLength(0);
    expect(report.skippedScopes).toEqual(['chat:1']);
    expect(report.backups).toHaveLength(0);
    expect(store.read('chat:1')).toBe(before);
  });
});

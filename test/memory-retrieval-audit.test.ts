import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { clearEmbedCache, hybridRank } from '../src/memory/semantic.js';
import { SessionStore } from '../src/memory/sessions.js';
import { MemoryStore } from '../src/memory.js';
import { createMemoryTool } from '../src/tools/memory.js';

describe('memory retrieval audit counterexamples', () => {
  it('does not let many turns from one session crowd out other matching sessions', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const statements: string[] = [];
      const traced = {
        exec: (sql: string) => db.exec(sql),
        prepare: (sql: string) => {
          statements.push(sql);
          return db.prepare(sql);
        },
      } as unknown as DatabaseSync;
      const store = new SessionStore({ db: traced });
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const id = store.begin('fixture-scope', `Session ${i}`);
        ids.push(id);
        for (let j = 0; j < (i === 0 ? 50 : 1); j++) store.addTurn(id, 'user', 'uniqueauditneedle');
      }
      const hits = store.search('uniqueauditneedle', 'fixture-scope', 5);
      expect(hits).toHaveLength(5);
      expect(new Set(hits.map((h) => h.sessionId)).size).toBe(5);
      expect(store.search('uniqueauditneedle', 'other-scope', 5)).toEqual([]);
      expect(statements.some((sql) => sql.includes(' LIKE '))).toBe(false);
    } finally {
      db.close();
    }
  });
  it('preserves an old exact lexical match outside the semantic candidate cap', async () => {
    clearEmbedCache();
    const items = [
      { text: 'critical old exact fact' },
      ...Array.from({ length: 200 }, (_, i) => ({ text: `recent unrelated ${i}` })),
    ];
    const hits = await hybridRank({
      query: 'critical old exact fact',
      items,
      text: (x) => x.text,
      lexical: (x, q) => (x.text === q ? 10 : 0),
      embedder: {
        embed: async (texts) => {
          expect(texts.length).toBeLessThanOrEqual(201);
          return texts.map(() => [0, 1]);
        },
      },
      limit: 5,
    });
    expect(hits.some((x) => x === items[0])).toBe(true);
  });
});

it('memory tool recalls persisted old facts without mixing scopes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-audit-'));
  try {
    const scope = 'synthetic-fixture';
    const store = new MemoryStore(dir);
    store.remember(scope, 'uniqueauditneedle from the old project');
    for (let i = 0; i < 205; i++) store.remember(scope, `unrelated fixture ${i}`);
    store.remember('other-fixture', 'uniqueauditneedle private elsewhere');
    const reopened = new MemoryStore(dir);
    const tool = createMemoryTool(reopened, () => scope, undefined, {
      embed: async (texts) => texts.map(() => [0, 1]),
    });
    const result = await tool.execute('audit', { action: 'recall', query: 'uniqueauditneedle' });
    const body = JSON.stringify(result);
    expect(body).toContain('uniqueauditneedle from the old project');
    expect(body).not.toContain('private elsewhere');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

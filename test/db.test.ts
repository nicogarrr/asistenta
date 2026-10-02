import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';

function tempStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pa-db-'));
  return { store: new Store(join(dir, 'test.db')), dir };
}

describe('Store', () => {
  it('appends entries and reads them back in order', () => {
    const { store, dir } = tempStore();
    try {
      store.appendEntry('c1', 'e1', null, 'user', { text: 'hola' });
      store.appendEntry('c1', 'e2', 'e1', 'assistant', { text: 'hey' });
      const entries = store.readEntries('c1');
      expect(entries.map((e) => e.id)).toEqual(['e1', 'e2']);
      expect(entries[0]?.parentId).toBeNull();
      expect(entries[1]?.parentId).toBe('e1');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies the latest edit to an entry without mutating history', () => {
    const { store, dir } = tempStore();
    try {
      store.appendEntry('c1', 'e1', null, 'user', { text: 'original' });
      store.editEntry('e1', 'c1', { text: 'corrected' });
      store.editEntry('e1', 'c1', { text: 'corrected twice' });
      expect(store.readEntries('c1')[0]?.body).toEqual({ text: 'corrected twice' });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits an entry whose edit replaced it with null', () => {
    const { store, dir } = tempStore();
    try {
      store.appendEntry('c1', 'e1', null, 'user', { text: 'a' });
      store.appendEntry('c1', 'e2', 'e1', 'assistant', { text: 'b' });
      store.editEntry('e1', 'c1', null);
      expect(store.readEntries('c1').map((e) => e.id)).toEqual(['e2']);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tracks purchase intents and finds the ones still in flight', () => {
    const { store, dir } = tempStore();
    try {
      const future = new Date(Date.now() + 60_000).toISOString();
      store.createIntent({
        id: 'p1',
        conversationId: 'c1',
        vendor: 'renfe',
        summary: 'Atocha to Sants',
        amountCents: 11205,
        currency: 'EUR',
        status: 'at_checkout',
        reference: null,
        detail: null,
        expiresAt: future,
      });
      store.createIntent({
        id: 'p2',
        conversationId: 'c1',
        vendor: 'renfe',
        summary: 'other',
        amountCents: 100,
        currency: 'EUR',
        status: 'paid',
        reference: 'ABC123',
        detail: null,
        expiresAt: future,
      });
      const open = store.listOpenIntents();
      expect(open).toHaveLength(1);
      expect(open[0]?.id).toBe('p1');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expires stale intents instead of leaving them retryable', () => {
    const { store, dir } = tempStore();
    try {
      store.createIntent({
        id: 'p1',
        conversationId: null,
        vendor: 'renfe',
        summary: 'stale',
        amountCents: 500,
        currency: 'EUR',
        status: 'unknown',
        reference: null,
        detail: null,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      expect(store.sweepExpired()).toBe(1);
      expect(store.getIntent('p1')?.status).toBe('expired');
      expect(store.listOpenIntents()).toHaveLength(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips kv values', () => {
    const { store, dir } = tempStore();
    try {
      store.kvSet('lastRun', 'abc');
      expect(store.kvGet('lastRun')).toBe('abc');
      expect(store.kvGet('missing')).toBeNull();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to open a database written by a newer schema', () => {
    const { store, dir } = tempStore();
    const file = join(dir, 'test.db');
    store.close();
    const raw = new Store(file);
    raw.kvSet('x', '1');
    raw.close();

    // Bump the version past what this build understands. Reaching into sqlite
    // directly is the point of the test.
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('UPDATE schema_version SET version = 999');
    db.close();

    let threw: unknown;
    try {
      const reopened = new Store(file);
      reopened.close();
    } catch (err) {
      threw = err;
    }
    // The failed constructor leaves its handle open on Windows, so clean up
    // deliberately instead of relying on GC.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    expect(String(threw)).toMatch(/newer than this build/);
  });
});

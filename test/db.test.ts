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

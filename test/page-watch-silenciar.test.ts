import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram.js';
import { pageNotice, vigilaSilenceArgs } from '../src/cli.js';
import {
  type CheckOutcome,
  describeWatch,
  PAGE_MUTE_MS,
  PageWatchStore,
} from '../src/watch/pages.js';

const URL = 'https://www.mediamarkt.es/es/product/_tele-123.html';

function store(now: { t: number }, db = new DatabaseSync(':memory:')) {
  return { db, s: new PageWatchStore(db, () => now.t) };
}

const drop: CheckOutcome = {
  kind: 'drop',
  cents: 45999,
  referenceCents: 49999,
  referenceKind: 'ultima',
  dropPct: 8,
  inStock: true,
};

describe('«🔕 Silenciar 1 día» en avisos de precio', () => {
  it('mute: solo desde su chat, 24 h, sobrevive a reabrir la base y se quita con unmute', () => {
    const now = { t: Date.UTC(2026, 9, 30, 19, 0) };
    const { db, s } = store(now);
    const w = s.add('chat1', URL, 'Tele');
    expect(s.mute('otro', w.id, PAGE_MUTE_MS)).toBeNull();
    expect(s.get(w.id)?.mutedUntil).toBe(0);
    const m = s.mute('chat1', w.id, PAGE_MUTE_MS);
    expect(m?.mutedUntil).toBe(now.t + 24 * 3_600_000);
    expect(new PageWatchStore(db, () => now.t).get(w.id)?.mutedUntil).toBe(now.t + PAGE_MUTE_MS);
    expect(s.unmute('otro', w.id)).toBeNull();
    expect(s.unmute('chat1', w.id)?.mutedUntil).toBe(0);
  });

  it('una base antigua sin la columna se migra sin perder vigilancias', () => {
    const now = { t: 1_000 };
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE page_watches (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, url TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      last_value TEXT NOT NULL DEFAULT '', last_checked_at INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)`);
    db.prepare('INSERT INTO page_watches (id, scope, url, created_at) VALUES (?, ?, ?, ?)').run(
      'abc12345',
      'c',
      URL,
      1,
    );
    const s = new PageWatchStore(db, () => now.t);
    expect(s.get('abc12345')?.mutedUntil).toBe(0);
  });

  it('el aviso lleva el botón, que equivale a /vigila silenciar <id>', () => {
    const now = { t: Date.UTC(2026, 9, 30, 19, 0) };
    const { s } = store(now);
    const w = s.add('chat1', URL, 'Tele', '', { dropPct: 5 });
    const n = pageNotice(w, drop, now.t);
    expect(n?.text).toContain('Bajada del 8 %');
    expect(n?.buttons?.map((b) => b.label)).toEqual(['🔕 Silenciar 1 día']);
    expect(n?.buttons?.map((b) => commandFromCallback(b.action))).toEqual([
      `/vigila silenciar ${w.id}`,
    ]);
  });

  it('silenciada: no se manda nada hasta que pasan las 24 h', () => {
    const now = { t: Date.UTC(2026, 9, 30, 19, 0) };
    const { s } = store(now);
    const w = s.add('chat1', URL, 'Tele', '', { dropPct: 5 });
    const muted = s.mute('chat1', w.id, PAGE_MUTE_MS);
    if (!muted) throw new Error('no muted');
    expect(pageNotice(muted, drop, now.t + 3_600_000)).toBeNull();
    expect(pageNotice(muted, drop, now.t + PAGE_MUTE_MS)?.text).toContain('Bajada');
  });

  it('el aviso de «no consigo leer» no lleva botón (no es un aviso de precio)', () => {
    const now = { t: 5 };
    const { s } = store(now);
    const w = s.add('chat1', URL, 'Tele');
    const n = pageNotice(
      w,
      { kind: 'error', message: 'captcha', failures: 3, notify: true } as CheckOutcome,
      now.t,
    );
    expect(n?.text).toContain('No consigo leer');
    expect(n?.buttons ?? []).toEqual([]);
  });

  it('/vigila silenciar|avisar <id> se reconoce; un enlace normal no', () => {
    expect(vigilaSilenceArgs('silenciar abc12345')).toEqual({
      action: 'silenciar',
      id: 'abc12345',
    });
    expect(vigilaSilenceArgs(' avisar abc12345 ')).toEqual({ action: 'avisar', id: 'abc12345' });
    expect(vigilaSilenceArgs(`${URL} objetivo=400€`)).toBeNull();
    expect(vigilaSilenceArgs('silenciar')).toBeNull();
  });

  it('/vigilando dice hasta cuándo está silenciada', () => {
    const now = { t: Date.UTC(2026, 9, 30, 19, 0) };
    const { s } = store(now);
    const w = s.add('chat1', URL, 'Tele');
    const m = s.mute('chat1', w.id, PAGE_MUTE_MS);
    if (!m) throw new Error('no muted');
    expect(describeWatch(m, null, now.t)).toContain('🔕 Silenciada hasta');
    expect(describeWatch(m, null, now.t + PAGE_MUTE_MS)).not.toContain('Silenciada');
    expect(describeWatch(w, null, now.t)).not.toContain('Silenciada');
  });
});

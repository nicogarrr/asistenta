// Episodic memory: sessions, instincts and workstreams over `:memory:` databases.
// In-memory on purpose: these stores must be constructible per test run without
// touching the agent's real state dir, and every assertion below is about
// behaviour that a crash or a late write could otherwise corrupt.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Instinct,
  InstinctStore,
  MATURE_THRESHOLD,
  RULE_THRESHOLD,
} from '../src/memory/instincts.js';
import { SessionStore } from '../src/memory/sessions.js';
import { MAX_ACTIVE, WorkstreamStore } from '../src/memory/workstreams.js';

const DAY_MS = 86_400_000;

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
});

afterEach(() => {
  db.close();
});

/**
 * A `DatabaseSync` that reports "no FTS5" the way a real build would: schema
 * statements mentioning fts5 fail, everything else is forwarded. `search` must
 * then answer through LIKE instead of raising.
 */
function withoutFts(real: DatabaseSync): DatabaseSync {
  return {
    exec(sql: string) {
      if (/fts5/i.test(sql)) throw new Error('no such module: fts5');
      return real.exec(sql);
    },
    prepare(sql: string) {
      if (/sessions_fts/.test(sql)) throw new Error('no such table: sessions_fts');
      return real.prepare(sql);
    },
  } as unknown as DatabaseSync;
}

/** Age one pattern without touching the others, so decay can be aimed. */
function backdate(pattern: string, days: number): void {
  db.prepare('UPDATE instincts SET last_seen = ? WHERE pattern = ?').run(
    Date.now() - days * DAY_MS,
    pattern,
  );
}

function countInstincts(pattern: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM instincts WHERE pattern = ?').get(pattern) as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

function matureHit(store: InstinctStore, pattern: string): Instinct | undefined {
  return store.suggest().find((i) => i.pattern === pattern);
}

describe('SessionStore', () => {
  it('registra turnos y cierra la sesión con un resumen', () => {
    const store = new SessionStore({ db });
    const id = store.begin('telegram:main', 'Comprar regalo para Ana');
    store.addTurn(id, 'user', '¿Qué regalo compro para Ana?');
    store.addTurn(id, 'assistant', 'Un libro podría ir bien');
    store.end(id, 'Se decidió regalar un libro a Ana');

    const turns = db
      .prepare('SELECT role, text FROM session_turns WHERE session_id = ? ORDER BY id')
      .all(id) as Array<{ role: string; text: string }>;
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[1]?.text).toBe('Un libro podría ir bien');

    const recent = store.recent('telegram:main');
    expect(recent).toHaveLength(1);
    expect(recent[0]?.id).toBe(id);
    expect(recent[0]?.summary).toBe('Se decidió regalar un libro a Ana');
    expect(recent[0]?.endedAt).not.toBeNull();
  });

  it('encuentra por título y por resumen, y filtra por scope', () => {
    const store = new SessionStore({ db });
    const a = store.begin('global', 'Regalo de cumpleaños para Ana');
    store.end(a, 'Presupuesto de 50 euros, opciones baratas');
    const b = store.begin('global', 'Notas varias');
    store.end(b, 'La cita con el dentista es el jueves a las 10');
    const c = store.begin('trabajo', 'Regalo de cumpleaños para la oficina');
    store.end(c, 'Se pidió una tarta');

    expect(
      store
        .search('cumpleaños')
        .map((h) => h.sessionId)
        .sort(),
    ).toEqual([a, c].sort());
    const bySummary = store.search('dentista');
    expect(bySummary.map((h) => h.sessionId)).toEqual([b]);
    expect(bySummary[0]?.snippet).toContain('dentista');
    expect(store.search('cumpleaños', 'trabajo').map((h) => h.sessionId)).toEqual([c]);
    expect(store.search('cumpleaños', 'otro')).toEqual([]);
  });

  it('recent devuelve las más recientes primero', () => {
    const store = new SessionStore({ db });
    for (const title of ['uno', 'dos', 'tres']) {
      const id = store.begin('global', title);
      store.end(id, `resumen ${title}`);
    }
    expect(store.recent().map((s) => s.title)).toEqual(['tres', 'dos', 'uno']);
  });

  it('una consulta MATCH hostil no lanza, cae a resultados', () => {
    const store = new SessionStore({ db });
    const id = store.begin('global', 'Prueba');
    store.end(id, 'algo sobre comillas " y paréntesis (');
    expect(() => store.search('"(')).not.toThrow();
    expect(() => store.search('NEAR(')).not.toThrow();
    expect(store.search('comillas').map((h) => h.sessionId)).toEqual([id]);
  });

  it('cae a LIKE cuando FTS5 no está disponible', () => {
    const store = new SessionStore({ db: withoutFts(db) });
    expect(store.ftsAvailable).toBe(false);
    const id = store.begin('global', 'Factura de la luz');
    store.addTurn(id, 'user', 'pagar la factura');
    store.end(id, 'Se pagó la factura de marzo');

    expect(store.search('luz').map((h) => h.sessionId)).toEqual([id]);
    const bySummary = store.search('marzo');
    expect(bySummary.map((h) => h.sessionId)).toEqual([id]);
    expect(bySummary[0]?.snippet).toContain('marzo');
    expect(store.search('factura', 'otro')).toEqual([]);
  });
});

describe('InstinctStore', () => {
  it('observe incrementa la confianza y es idempotente por pattern+category+scope', () => {
    const store = new InstinctStore({ db });
    const pattern = 'el usuario pide el parte del tiempo';
    for (let i = 0; i < MATURE_THRESHOLD; i++) store.observe(pattern, 'pref');

    const mature = store.suggest();
    expect(mature).toHaveLength(1);
    expect(mature[0]?.pattern).toBe(pattern);
    expect(mature[0]?.confidence).toBe(MATURE_THRESHOLD);

    // Misma frase en otro scope u otra categoría es otro instinto aparte.
    store.observe(pattern, 'pref', 'trabajo');
    store.observe(pattern, 'seq');
    expect(store.suggest('global')).toHaveLength(1);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM instincts').get() as { n: number };
    expect(Number(rows.n)).toBe(3);
  });

  it('suggest solo con confianza >= MATURE_THRESHOLD y rules solo >= RULE_THRESHOLD', () => {
    const store = new InstinctStore({ db });
    const pattern = 'cierra los correos con dos besos';
    for (let i = 0; i < MATURE_THRESHOLD - 1; i++) store.observe(pattern, 'pref');
    expect(store.suggest()).toEqual([]);
    store.observe(pattern, 'pref');
    expect(store.suggest()).toHaveLength(1);
    expect(store.rules()).toEqual([]);

    for (let i = 0; i < RULE_THRESHOLD - MATURE_THRESHOLD; i++) store.observe(pattern, 'pref');
    const rules = store.rules();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.confidence).toBe(RULE_THRESHOLD);
  });

  it('decay reduce lo que no se ve y borra lo que llega a cero', () => {
    const store = new InstinctStore({ db });
    const old = 'patrón antiguo';
    const fresh = 'patrón reciente';
    for (let i = 0; i < RULE_THRESHOLD; i++) {
      store.observe(old, 'seq');
      store.observe(fresh, 'seq');
    }
    backdate(old, 200);

    expect(store.decay(90)).toBe(1);
    // Solo el patrón caducado pierde confianza; rules queda con el fresco.
    expect(store.rules().map((i) => i.pattern)).toEqual([fresh]);
    expect(matureHit(store, old)?.confidence).toBe(RULE_THRESHOLD - 1);
    expect(matureHit(store, fresh)?.confidence).toBe(RULE_THRESHOLD);

    // 9 → 0 y borrado: diez sweeps en total sobre el patrón caducado.
    for (let i = 0; i < 9; i++) store.decay(90);
    expect(countInstincts(old)).toBe(0);
    expect(store.suggest().map((i) => i.pattern)).toEqual([fresh]);
    expect(store.decay(90)).toBe(0);
  });

  it('promote fuerza la confianza hasta RULE_THRESHOLD', () => {
    const store = new InstinctStore({ db });
    for (let i = 0; i < MATURE_THRESHOLD; i++) store.observe('preferencia sutil', 'pref');
    const found = store.suggest().at(0);
    if (!found) throw new Error('expected a mature instinct');
    expect(store.rules()).toEqual([]);
    store.promote(found.id);
    expect(store.rules().at(0)?.confidence).toBe(RULE_THRESHOLD);
    expect(() => store.promote('no-existe')).toThrow();
  });
});

describe('WorkstreamStore', () => {
  it('create, update y read mantienen el frente al día', () => {
    const store = new WorkstreamStore({ db });
    expect(store.read('no-existe')).toBeNull();
    const id = store.create('global', 'Migrar el blog', 'Publicar la web nueva');
    const created = store.read(id);
    expect(created?.status).toBe('active');
    expect(created?.title).toBe('Migrar el blog');
    expect(created?.goal).toBe('Publicar la web nueva');
    expect(created?.nextSteps).toBeNull();

    store.update(id, {
      title: 'Migrar el blog a Astro',
      nextSteps: 'Elegir plantilla',
      constraints: 'Sin gastos',
      decisions: 'Usar Astro',
    });
    const updated = store.read(id);
    expect(updated?.title).toBe('Migrar el blog a Astro');
    expect(updated?.nextSteps).toBe('Elegir plantilla');
    expect(updated?.constraints).toBe('Sin gastos');
    expect(updated?.decisions).toBe('Usar Astro');
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created?.updatedAt ?? 0);
    expect(store.active().map((w) => w.id)).toEqual([id]);
  });

  it('create lanza al exceder MAX_ACTIVE en el scope', () => {
    const store = new WorkstreamStore({ db });
    for (let i = 0; i < MAX_ACTIVE; i++) store.create('global', `Frente ${i}`, 'una meta');
    expect(() => store.create('global', 'uno más', 'una meta')).toThrow(/olvida/i);
    // El límite es por scope: otro ámbito sigue teniendo sitio.
    expect(() => store.create('trabajo', 'Otro frente', 'una meta')).not.toThrow();
  });

  it('forget deja tombstone y ningún save posterior lo resucita', () => {
    const store = new WorkstreamStore({ db });
    const id = store.create('global', 'Proyecto temporal', 'Terminar la mudanza');
    store.forget(id);
    expect(store.read(id)?.status).toBe('forgotten');

    // Un save interrumpido que llegue después escribe los demás campos,
    // pero el estado olvidado se queda donde está.
    store.update(id, { status: 'active', goal: 'Terminar la mudanza ya' });
    expect(store.read(id)?.status).toBe('forgotten');
    expect(store.read(id)?.goal).toBe('Terminar la mudanza ya');
    expect(store.active()).toEqual([]);
    expect(() => store.create('global', 'Siguiente', 'otra meta')).not.toThrow();
  });

  it('index devuelve una lista compacta en español', () => {
    const store = new WorkstreamStore({ db });
    const id = store.create('global', 'Migrar el blog', 'Publicar la web');
    store.update(id, { nextSteps: 'Elegir plantilla' });
    store.create('global', 'Comprar bicicleta', 'Elegir modelo');

    const text = store.index();
    expect(text).toContain('Frentes de trabajo');
    expect(text).toContain('[activo]');
    expect(text).toContain('Migrar el blog');
    expect(text).toContain('objetivo: Publicar la web');
    expect(text).toContain('siguiente: Elegir plantilla');
    expect(text.split('\n')).toHaveLength(3);
    expect(store.index('trabajo')).toBe('Sin frentes de trabajo abiertos.');
  });
});

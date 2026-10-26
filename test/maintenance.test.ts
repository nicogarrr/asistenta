/**
 * Retención y borrado por scope sobre estado temporal. Nada toca el directorio
 * real del agente: cada prueba crea su propio directorio y sus propias bases.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { eraseScope, pruneDocuments, pruneSessions } from '../src/maintenance.js';
import { SessionStore } from '../src/memory/sessions.js';
import { memoryFile } from '../src/memory.js';

const DAY = 86_400_000;
/** Reloj fijo: la retención se prueba con fechas, nunca esperando. */
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  return db;
}

function countTurns(db: DatabaseSync, sessionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM session_turns WHERE session_id = ?')
    .get(sessionId) as { n: number | bigint } | undefined;
  return Number(row?.n ?? 0);
}

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // Algunas pruebas cierran la base a propósito.
    }
  }
  dbs.length = 0;
  for (const dir of dirs)
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  dirs.length = 0;
});

describe('pruneSessions', () => {
  it('borra las terminadas antiguas con sus turnos y respeta recientes y activas', () => {
    const db = memoryDb();
    const store = new SessionStore({ db });

    const vieja = store.begin('telegram:main:1#main', 'Vieja');
    store.addTurn(vieja, 'user', 'palabra-que-solo-existe-en-la-vieja');
    store.addTurn(vieja, 'assistant', 'respuesta antigua');
    store.end(vieja, 'cerrada hace mucho');

    const reciente = store.begin('telegram:main:1#main', 'Reciente');
    store.addTurn(reciente, 'user', 'palabra-reciente');
    store.end(reciente, 'cerrada ayer');

    const activa = store.begin('telegram:main:1#main', 'Activa');
    store.addTurn(activa, 'user', 'sigue abierta');

    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(NOW - 10 * DAY, vieja);
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(NOW - DAY, reciente);
    db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(NOW - 30 * DAY, activa);

    expect(pruneSessions(db, 7 * DAY, NOW)).toBe(1);

    const vivas = store
      .recent(undefined, 10)
      .map((session) => session.id)
      .sort();
    expect(vivas).toEqual([reciente, activa].sort());
    expect(countTurns(db, vieja)).toBe(0);
    expect(countTurns(db, reciente)).toBe(1);
    expect(countTurns(db, activa)).toBe(1);
    // Los triggers han limpiado también el índice FTS de turnos y cabecera.
    expect(store.search('palabra-que-solo-existe-en-la-vieja')).toEqual([]);
    expect(store.search('palabra-reciente').map((hit) => hit.sessionId)).toEqual([reciente]);
  });

  it('con un umbral corto no borra nada si todas son más nuevas o siguen abiertas', () => {
    const db = memoryDb();
    const store = new SessionStore({ db });
    const reciente = store.begin('global', 'Nueva');
    store.end(reciente, 'fin');
    const abierta = store.begin('global', 'Abierta');
    db.prepare('UPDATE sessions SET started_at = ? WHERE id IN (?, ?)').run(
      NOW - DAY,
      reciente,
      abierta,
    );

    expect(pruneSessions(db, 7 * DAY, NOW)).toBe(0);
  });
});

describe('pruneDocuments', () => {
  it('borra solo los .txt más viejos por mtime y deja el resto', () => {
    const dir = tempDir('pa-docs-');
    const viejo = join(dir, 'viejo.txt');
    const nuevo = join(dir, 'nuevo.txt');
    const nota = join(dir, 'nota.md');
    const subdir = join(dir, 'sub');
    const dentro = join(subdir, 'viejo.txt');
    writeFileSync(viejo, 'antiguo');
    writeFileSync(nuevo, 'reciente');
    writeFileSync(nota, 'no es un mirror');
    mkdirSync(subdir);
    writeFileSync(dentro, 'tampoco se mira');
    const viejoSeg = (NOW - 10 * DAY) / 1000;
    const nuevoSeg = (NOW - DAY) / 1000;
    utimesSync(viejo, viejoSeg, viejoSeg);
    utimesSync(nuevo, nuevoSeg, nuevoSeg);
    utimesSync(nota, viejoSeg, viejoSeg);
    utimesSync(dentro, viejoSeg, viejoSeg);

    expect(pruneDocuments(dir, 7 * DAY, NOW)).toBe(1);

    expect(existsSync(viejo)).toBe(false);
    expect(readFileSync(nuevo, 'utf8')).toBe('reciente');
    expect(readFileSync(nota, 'utf8')).toBe('no es un mirror');
    expect(readFileSync(dentro, 'utf8')).toBe('tampoco se mira');
  });

  it('un directorio ausente devuelve cero en vez de lanzar', () => {
    const dir = tempDir('pa-docs-ausente-');
    expect(pruneDocuments(join(dir, 'no-existe'), DAY, NOW)).toBe(0);
  });
});

describe('eraseScope', () => {
  it('borra solo la memoria, las sesiones y el perfil del scope pedido', () => {
    const stateDir = tempDir('pa-erase-');
    const memoryDir = join(stateDir, 'memory');
    const profileDir = join(stateDir, 'profile');
    mkdirSync(memoryDir);
    mkdirSync(profileDir);

    const propio = 'telegram:main:111#main';
    const ajeno = 'telegram:main:222#main';
    writeFileSync(memoryFile(memoryDir, propio), '# Memory for 111\n');
    writeFileSync(memoryFile(memoryDir, ajeno), '# Memory for 222\n');
    writeFileSync(join(profileDir, '111.json'), '[]\n');
    writeFileSync(join(profileDir, '222.json'), '[]\n');
    writeFileSync(join(profileDir, 'local.json'), '[]\n');

    const db = memoryDb();
    const store = new SessionStore({ db });
    const dePropio = store.begin(propio, 'Mía');
    store.addTurn(dePropio, 'user', 'dato privado');
    store.end(dePropio, 'fin');
    const deAjeno = store.begin(ajeno, 'Ajena');
    store.addTurn(deAjeno, 'user', 'dato ajeno');
    store.end(deAjeno, 'fin');
    const global = store.begin('global', 'Global');
    store.end(global, 'fin');

    expect(eraseScope({ stateDir, scope: propio, db })).toEqual({
      memoryFile: true,
      sessions: 1,
      profile: true,
    });

    expect(existsSync(memoryFile(memoryDir, propio))).toBe(false);
    expect(existsSync(memoryFile(memoryDir, ajeno))).toBe(true);
    expect(store.recent(propio)).toEqual([]);
    expect(store.recent(ajeno).map((s) => s.id)).toEqual([deAjeno]);
    expect(store.recent('global').map((s) => s.id)).toEqual([global]);
    expect(countTurns(db, dePropio)).toBe(0);
    expect(countTurns(db, deAjeno)).toBe(1);
    expect(existsSync(join(profileDir, '111.json'))).toBe(false);
    expect(existsSync(join(profileDir, '222.json'))).toBe(true);
    expect(existsSync(join(profileDir, 'local.json'))).toBe(true);
  });

  it('en modo local borra local.json y tolera que falte todo lo demás', () => {
    const stateDir = tempDir('pa-erase-local-');
    const memoryDir = join(stateDir, 'memory');
    const profileDir = join(stateDir, 'profile');
    mkdirSync(memoryDir);
    mkdirSync(profileDir);
    writeFileSync(memoryFile(memoryDir, 'local'), '# Memory for local\n');
    writeFileSync(join(profileDir, 'local.json'), '[]\n');

    expect(eraseScope({ stateDir, scope: 'local' })).toEqual({
      memoryFile: true,
      sessions: 0,
      profile: true,
    });
    expect(existsSync(memoryFile(memoryDir, 'local'))).toBe(false);
    expect(existsSync(join(profileDir, 'local.json'))).toBe(false);

    // Repetir sobre un estado ya vacío es inofensivo.
    expect(eraseScope({ stateDir, scope: 'local' })).toEqual({
      memoryFile: false,
      sessions: 0,
      profile: false,
    });
  });

  it('nunca lanza con base sin esquema, base cerrada o scope con traversal', () => {
    const stateDir = tempDir('pa-erase-roto-');
    mkdirSync(join(stateDir, 'memory'));
    const fuera = join(stateDir, 'fuera.md');
    writeFileSync(fuera, 'no se debe borrar');

    const sinEsquema = memoryDb();
    expect(() =>
      eraseScope({ stateDir, scope: 'telegram:main:999#main', db: sinEsquema }),
    ).not.toThrow();

    const cerrada = new DatabaseSync(':memory:');
    cerrada.close();
    expect(() =>
      eraseScope({ stateDir, scope: 'telegram:main:999#main', db: cerrada }),
    ).not.toThrow();

    expect(eraseScope({ stateDir, scope: '../fuera' })).toEqual({
      memoryFile: false,
      sessions: 0,
      profile: false,
    });
    expect(existsSync(fuera)).toBe(true);
  });
});

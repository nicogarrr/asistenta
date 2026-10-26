import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileFact } from '../src/memory/profile.js';
import { OwnerProfile } from '../src/memory/profile.js';
import { SessionStore } from '../src/memory/sessions.js';
import { MemoryStore } from '../src/memory.js';

// Log writes go under the real state dir by default; this file only needs temp dirs.
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const SCOPE_A = 'telegram:main:111';
const SCOPE_B = 'telegram:main:222';

let dir = '';
let db: DatabaseSync | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-e2e-memory-'));
});

afterEach(() => {
  db?.close();
  db = undefined;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('memory scopes end to end', () => {
  it('isolates remember, recall and list between two scopes', () => {
    const memory = new MemoryStore(join(dir, 'memory'));

    const a = memory.remember(SCOPE_A, 'El gato de Ana se llama Miso', { tags: ['mascota'] });
    const b = memory.remember(SCOPE_B, 'El perro de Luis se llama Trufa', { tags: ['mascota'] });

    expect(memory.all(SCOPE_A).map((entry) => entry.text)).toEqual([
      'El gato de Ana se llama Miso',
    ]);
    expect(memory.all(SCOPE_B).map((entry) => entry.text)).toEqual([
      'El perro de Luis se llama Trufa',
    ]);
    expect(memory.recall(SCOPE_A, 'Luis')).toEqual([]);
    expect(memory.recall(SCOPE_B, 'Miso')).toEqual([]);
    expect(memory.recall(SCOPE_A, 'gato').map((entry) => entry.id)).toEqual([a.id]);
    expect(memory.recall(SCOPE_B, 'perro').map((entry) => entry.id)).toEqual([b.id]);
    expect(memory.scopes()).toEqual([SCOPE_A, SCOPE_B].sort());
    expect(memory.read(SCOPE_A)).not.toContain('Trufa');
    expect(memory.read(SCOPE_B)).not.toContain('Miso');

    // No `erase` API exists in src/memory*; `clear(scope)` is the scope wipe.
    expect(memory.clear(SCOPE_A)).toBe(1);
    expect(memory.all(SCOPE_A)).toEqual([]);
    expect(memory.all(SCOPE_B).map((entry) => entry.id)).toEqual([b.id]);

    // And the per-id delete still works on the surviving scope.
    expect(memory.forget(SCOPE_B, b.id)).toBe(true);
    expect(memory.all(SCOPE_B)).toEqual([]);
  });

  it('finds a saved user turn in its own scope and not in another one', () => {
    db = new DatabaseSync(join(dir, 'sessions.db'));
    const sessions = new SessionStore({ db });

    const a = sessions.begin(SCOPE_A, 'Reserva de padel');
    sessions.addTurn(a, 'user', 'quiero reservar una pista de padel el jueves');
    sessions.addTurn(a, 'assistant', 'Hay hueco a las siete');
    sessions.end(a, 'Pista reservada para el jueves');

    const b = sessions.begin(SCOPE_B, 'Reserva de tenis');
    sessions.addTurn(b, 'user', 'quiero reservar una pista de tenis el viernes');
    sessions.end(b, 'Pista de tenis pendiente');

    const hitsA = sessions.search('padel', SCOPE_A);
    expect(hitsA.map((hit) => hit.sessionId)).toEqual([a]);
    expect(hitsA[0]?.snippet).toContain('padel');
    expect(sessions.search('padel', SCOPE_B)).toEqual([]);
    expect(sessions.search('tenis', SCOPE_A)).toEqual([]);
    expect(sessions.search('tenis', SCOPE_B).map((hit) => hit.sessionId)).toEqual([b]);
    expect(sessions.recent(SCOPE_A).map((session) => session.id)).toEqual([a]);

    const exported = sessions.exportSession(a);
    expect(exported?.turns[0]).toMatchObject({
      role: 'user',
      text: 'quiero reservar una pista de padel el jueves',
    });
    expect(exported?.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
  });

  it('migrates PERFIL.md and keeps only current facts rendered after an update', () => {
    const legacyPath = join(dir, 'PERFIL.md');
    writeFileSync(
      legacyPath,
      [
        '# PERFIL',
        '',
        'Vive en Oviedo',
        '§',
        'Prefiere el cafe con leche',
        '§',
        'Trabaja de noche',
      ].join('\n'),
      'utf8',
    );

    const file = join(dir, 'owner.json');
    const profile = new OwnerProfile(file);
    expect(profile.migrateFromLegacy(readFileSync(legacyPath, 'utf8'))).toBe(3);
    expect(profile.load().map((fact) => fact.text)).toEqual([
      'Vive en Oviedo',
      'Prefiere el cafe con leche',
      'Trabaja de noche',
    ]);

    const city = profile.load().find((fact) => fact.text === 'Vive en Oviedo');
    if (!city) throw new Error('la migracion no conservo el hecho de la ciudad');
    const updated = profile.update(city.id, { text: 'Vive en Madrid', tags: ['ciudad'] });
    if (!updated) throw new Error('update devolvio null');

    expect(profile.render()).toContain('Vive en Madrid');
    expect(profile.render()).toContain('Prefiere el cafe con leche');
    expect(profile.render()).not.toContain('Vive en Oviedo');
    expect(profile.search('oviedo')).toEqual([]);
    expect(profile.search('madrid').map((fact) => fact.id)).toEqual([updated.id]);

    const exported = JSON.parse(profile.export()) as ProfileFact[];
    expect(exported).toHaveLength(4);
    expect(exported.find((fact) => fact.id === city.id)?.supersededBy).toBe(updated.id);
    expect(exported.find((fact) => fact.id === updated.id)?.supersededBy).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(profile.export());
  });
});

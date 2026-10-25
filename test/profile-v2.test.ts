/**
 * Perfil v2: hechos estructurados por propietario. Todo corre contra un
 * directorio temporal: un perfil que escribe fuera de su ruta sería un bug que
 * merece romper el test.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileFact } from '../src/memory/profile.js';
import { OwnerProfile, PROFILE_MAX_FACTS } from '../src/memory/profile.js';

// El log real escribe bajo el directorio de estado: se silencia en los tests.
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

let dir = '';
let file = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-profile-v2-'));
  file = join(dir, 'owner.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('OwnerProfile.add y load', () => {
  it('guarda un hecho con id, tags y source, y otra instancia lo lee', () => {
    const profile = new OwnerProfile(file);
    const fact = profile.add('Me llamo Ana', { tags: ['Identidad', '#madrid'], source: 'user' });

    expect(fact.id).toMatch(/^[a-z0-9-]+$/);
    expect(fact.id.length).toBeLessThanOrEqual(16);
    expect(fact.text).toBe('Me llamo Ana');
    expect(fact.tags).toEqual(['identidad', 'madrid']);
    expect(fact.source).toBe('user');
    expect(fact.supersededBy).toBeNull();
    expect(fact.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const reread = new OwnerProfile(file);
    expect(reread.load()).toEqual([fact]);
    expect(reread.render()).toBe(
      `- [${fact.id}] (${fact.updatedAt.slice(0, 10)}) #identidad #madrid Me llamo Ana`,
    );
  });

  it('no crea fichero al cargar y tolera JSON corrupto o con forma rara', () => {
    const profile = new OwnerProfile(file);
    expect(profile.load()).toEqual([]);
    expect(existsSync(file)).toBe(false);

    writeFileSync(file, '{ esto no es JSON', 'utf8');
    expect(new OwnerProfile(file).load()).toEqual([]);

    writeFileSync(file, JSON.stringify({ facts: 'no es un array' }), 'utf8');
    expect(new OwnerProfile(file).load()).toEqual([]);

    // Un add posterior reescribe el fichero corrupto con un perfil válido.
    const recovered = new OwnerProfile(file);
    recovered.add('Hecho recuperado');
    expect(recovered.load().map((fact) => fact.text)).toEqual(['Hecho recuperado']);
  });

  it('añadir el mismo texto es idempotente y fusiona etiquetas', () => {
    const profile = new OwnerProfile(file);
    const first = profile.add('Vivo en Oviedo', { tags: ['ciudad'] });
    const second = profile.add('Vivo en Oviedo', { tags: ['norte'] });

    expect(second.id).toBe(first.id);
    expect(second.tags).toEqual(['ciudad', 'norte']);
    expect(profile.load()).toHaveLength(1);
  });
});

describe('validación de entradas', () => {
  it('rechaza vacío, multilínea y secretos con mensajes en español', () => {
    const profile = new OwnerProfile(file);

    expect(() => profile.add('   ')).toThrow(/vacío/);
    expect(() => profile.add('primera línea\nsegunda línea')).toThrow(/una sola línea/);
    expect(() => profile.add('mi contraseña de la banca es 1234')).toThrow(/contraseña/);
    expect(() => profile.add(`sk-${'a'.repeat(20)}`)).toThrow(/token/);

    expect(profile.load()).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});

describe('OwnerProfile.update', () => {
  it('crea una versión nueva y marca la anterior como sustituida', () => {
    const profile = new OwnerProfile(file);
    const old = profile.add('Vivo en Oviedo', { tags: ['ciudad'] });
    const next = profile.update(old.id, { text: 'Vivo en Madrid', tags: ['ciudad', 'capital'] });

    if (next === null) throw new Error('update devolvió null');
    expect(next.id).not.toBe(old.id);
    expect(next.text).toBe('Vivo en Madrid');
    expect(next.tags).toEqual(['ciudad', 'capital']);
    expect(next.supersededBy).toBeNull();

    const oldFact = profile.load().find((fact) => fact.id === old.id);
    expect(oldFact?.supersededBy).toBe(next.id);
    expect(profile.render()).toContain('Vivo en Madrid');
    expect(profile.render()).not.toContain('Oviedo');
    expect(profile.search('oviedo')).toEqual([]);
    expect(profile.search('madrid')).toHaveLength(1);

    const exported: ProfileFact[] = JSON.parse(profile.export());
    expect(exported).toHaveLength(2);
    expect(exported.find((fact) => fact.id === old.id)?.supersededBy).toBe(next.id);
  });

  it('devuelve null para ids desconocidos o ya sustituidos', () => {
    const profile = new OwnerProfile(file);
    const old = profile.add('Prefiere el té');
    const next = profile.update(old.id, { text: 'Prefiere el café' });

    expect(next).not.toBeNull();
    expect(profile.update('no-existe', { text: 'nada' })).toBeNull();
    expect(profile.update(old.id, { text: 'otra cosa' })).toBeNull();
  });

  it('valida el texto nuevo y no toca el fichero si es inválido', () => {
    const profile = new OwnerProfile(file);
    const fact = profile.add('Prefiere el té');

    expect(() => profile.update(fact.id, { text: '' })).toThrow(/vacío/);
    expect(() => profile.update(fact.id, { text: 'a\nb' })).toThrow(/una sola línea/);
    expect(() => profile.update(fact.id, { text: 'password: x' })).toThrow(/contraseña/);
    expect(profile.load()).toEqual([fact]);
  });
});

describe('OwnerProfile.forget', () => {
  it('borra por id exacto o subcadena sin tocar las sustituidas', () => {
    const profile = new OwnerProfile(file);
    const cafe = profile.add('Le gusta el café');
    const madrid = profile.add('Vive en Madrid');
    const trabajo = profile.add('Trabaja en Oviedo');
    const nuevoTrabajo = profile.update(trabajo.id, { text: 'Trabaja en casa' });
    if (nuevoTrabajo === null) throw new Error('update devolvió null');

    expect(profile.forget(cafe.id)).toBe(1);
    expect(profile.forget('MADRID')).toBe(1);

    const oldFact = profile.load().find((fact) => fact.id === trabajo.id);
    expect(oldFact?.supersededBy).toBe(nuevoTrabajo.id);
    expect(profile.forget(trabajo.id)).toBe(0);
    expect(profile.forget(oldFact?.id ?? '')).toBe(0);

    expect(profile.forget('casa')).toBe(1);
    expect(profile.render()).toBe('');
    expect(profile.load()).toHaveLength(1);
    expect(profile.forget('')).toBe(0);
    expect(profile.forget('no aparece')).toBe(0);

    // Madrid ya no está, pero el método no debe fingir que borró algo.
    expect(profile.forget(madrid.id)).toBe(0);
  });
});

describe('OwnerProfile.search', () => {
  it('busca sin distinguir mayúsculas ni acentos y solo entre vigentes', () => {
    const profile = new OwnerProfile(file);
    profile.add('Vive en Oviedo', { tags: ['ciudad'] });
    profile.add('Le gusta el café');
    profile.add('Trabaja como profesor');
    const rojo = profile.add('Su color favorito es el rojo');
    profile.update(rojo.id, { text: 'Su color favorito es el azul' });

    expect(profile.search('OVIEDO').map((fact) => fact.text)).toEqual(['Vive en Oviedo']);
    expect(profile.search('cafe').map((fact) => fact.text)).toEqual(['Le gusta el café']);
    expect(profile.search('ciudad').map((fact) => fact.text)).toEqual(['Vive en Oviedo']);
    expect(profile.search('color azul').map((fact) => fact.text)).toEqual([
      'Su color favorito es el azul',
    ]);
    expect(profile.search('rojo')).toEqual([]);
    expect(profile.search('')).toEqual([]);
    expect(profile.search('zzz')).toEqual([]);
  });
});

describe('OwnerProfile.migrateFromLegacy', () => {
  it('parte por § y por líneas, añade como user y salta duplicados exactos', () => {
    const profile = new OwnerProfile(file);
    const legacy = [
      '# PERFIL',
      '',
      'Se llama Ana',
      '§',
      'Prefiere respuestas cortas',
      'Se llama Ana',
      '',
      'Vive en Madrid',
    ].join('\n');

    expect(profile.migrateFromLegacy(legacy)).toBe(3);
    const facts = profile.load();
    expect(facts.map((fact) => fact.text)).toEqual([
      'Se llama Ana',
      'Prefiere respuestas cortas',
      'Vive en Madrid',
    ]);
    expect(facts.every((fact) => fact.source === 'user')).toBe(true);
    expect(profile.migrateFromLegacy(legacy)).toBe(0);
  });

  it('descarta secretos y no escribe nada si no queda nada nuevo', () => {
    const profile = new OwnerProfile(file);
    expect(profile.migrateFromLegacy('')).toBe(0);
    expect(existsSync(file)).toBe(false);

    expect(profile.migrateFromLegacy('mi contraseña de la banca es 1234')).toBe(0);
    expect(profile.load()).toEqual([]);
    expect(existsSync(file)).toBe(false);

    expect(profile.migrateFromLegacy('Le gusta el cine')).toBe(1);
    expect(profile.migrateFromLegacy('Le gusta el cine')).toBe(0);
    expect(profile.load()).toHaveLength(1);
  });
});

describe('persistencia atómica', () => {
  it('dos instancias ven lo de la otra y no quedan temporales', () => {
    const first = new OwnerProfile(file);
    first.add('Primer hecho');
    const second = new OwnerProfile(file);
    second.add('Segundo hecho');
    const third = new OwnerProfile(file);

    expect(third.load().map((fact) => fact.text)).toEqual(['Primer hecho', 'Segundo hecho']);
    expect(readFileSync(file, 'utf8')).toBe(third.export());
    expect(readdirSync(dir)).toEqual(['owner.json']);
  });
});

describe('tope de entradas', () => {
  it('desaloja las más antiguas al pasar de 200', () => {
    const profile = new OwnerProfile(file);
    for (let index = 0; index <= PROFILE_MAX_FACTS; index++) {
      profile.add(`Hecho número ${index}`);
    }

    const facts = profile.load();
    expect(facts).toHaveLength(PROFILE_MAX_FACTS);
    expect(facts[0]?.text).toBe('Hecho número 1');
    expect(facts.at(-1)?.text).toBe(`Hecho número ${PROFILE_MAX_FACTS}`);
  });
});

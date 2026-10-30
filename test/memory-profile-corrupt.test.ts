import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OwnerProfile } from '../src/memory/profile.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-profile-corrupt-'));
  file = join(dir, 'perfil.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const corruptCopies = () =>
  readdirSync(dir).filter((name) => name.startsWith('perfil.json.corrupt-'));

describe('perfil del dueño corrupto', () => {
  it('add no pisa un perfil ilegible: lo aparta con su contenido intacto', () => {
    const broken = '[{"id":"p1","text":"vive en Madrid","tags":[],"source":"user"';
    writeFileSync(file, broken, 'utf8');
    const profile = new OwnerProfile(file);
    expect(profile.load()).toEqual([]);
    profile.add('prefiere el té verde');
    expect(profile.load().map((fact) => fact.text)).toEqual(['prefiere el té verde']);
    const copies = corruptCopies();
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(dir, copies[0] as string), 'utf8')).toBe(broken);
  });

  it('un JSON que no es una lista de hechos también se aparta', () => {
    writeFileSync(file, '"texto suelto"', 'utf8');
    new OwnerProfile(file).add('trabaja en remoto');
    expect(corruptCopies()).toHaveLength(1);
  });

  it('un perfil sano, vacío o con envoltorio {facts} no deja copias', () => {
    const profile = new OwnerProfile(file);
    profile.add('vive en Madrid');
    profile.add('come sin gluten');
    writeFileSync(join(dir, 'b.json'), '{"facts":[]}', 'utf8');
    new OwnerProfile(join(dir, 'b.json')).add('usa Windows');
    writeFileSync(join(dir, 'c.json'), '', 'utf8');
    new OwnerProfile(join(dir, 'c.json')).add('tiene un LG');
    expect(readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toEqual([]);
  });
});

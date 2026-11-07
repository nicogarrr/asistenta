// asis-memoria-8: la memoria repartida (memory/, snapshot/PERFIL.md, skills/)
// pasa a memoria/ una sola vez, verificada byte a byte y con los originales
// guardados intactos en memoria-copia/. Nada se pierde.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrarMemoriaACarpeta } from '../src/memory/migrar-carpeta.js';
import { paths } from '../src/paths.js';

function estadoViejo(): string {
  const state = mkdtempSync(join(tmpdir(), 'mem8mig-'));
  mkdirSync(join(state, 'memory'));
  writeFileSync(
    join(state, 'memory', 'telegram-1.md'),
    '# Memoria\n\n- [a1] (2026-11-01) Nico vive en Madrid\n',
  );
  mkdirSync(join(state, 'snapshot'));
  writeFileSync(join(state, 'snapshot', 'PERFIL.md'), 'Le gusta el café solo\n');
  writeFileSync(join(state, 'snapshot', 'nudges.json'), '{}');
  mkdirSync(join(state, 'skills', 'reservar'), { recursive: true });
  writeFileSync(join(state, 'skills', 'reservar', 'SKILL.md'), '---\nname: reservar\n---\n');
  return state;
}

describe('migración a la carpeta memoria/', () => {
  it('las rutas vivas apuntan a memoria/', () => {
    expect(paths.memory).toBe(join(paths.state, 'memoria', 'notas'));
    expect(paths.perfil).toBe(join(paths.state, 'memoria'));
    expect(paths.procedimientos).toBe(join(paths.state, 'memoria', 'procedimientos'));
  });

  it('mueve todo sin perder un byte y guarda los originales', () => {
    const state = estadoViejo();
    const mem = join(state, 'memoria');
    const r = migrarMemoriaACarpeta(state, mem, new Date(2026, 10, 7, 10, 30));
    expect(r).toMatchObject({ hecho: true, copiados: 3, conflictos: 0, errores: [] });
    expect(readFileSync(join(mem, 'notas', 'telegram-1.md'), 'utf8')).toContain(
      'Nico vive en Madrid',
    );
    expect(readFileSync(join(mem, 'PERFIL.md'), 'utf8')).toBe('Le gusta el café solo\n');
    expect(existsSync(join(mem, 'procedimientos', 'reservar', 'SKILL.md'))).toBe(true);
    // Originales intactos en la copia; lo que no es memoria (nudges) no se toca.
    const copia = r.copia as string;
    expect(readFileSync(join(copia, 'memory', 'telegram-1.md'), 'utf8')).toContain('Madrid');
    expect(readFileSync(join(copia, 'snapshot-PERFIL.md'), 'utf8')).toBe('Le gusta el café solo\n');
    expect(existsSync(join(state, 'memory'))).toBe(false);
    expect(existsSync(join(state, 'snapshot', 'nudges.json'))).toBe(true);
    expect(existsSync(join(mem, '.migrado.json'))).toBe(true);
  });

  it('una sola vez: el segundo arranque no hace nada', () => {
    const state = estadoViejo();
    const mem = join(state, 'memoria');
    migrarMemoriaACarpeta(state, mem);
    mkdirSync(join(state, 'memory'));
    writeFileSync(join(state, 'memory', 'otro.md'), 'x');
    expect(migrarMemoriaACarpeta(state, mem).hecho).toBe(false);
    expect(existsSync(join(mem, 'notas', 'otro.md'))).toBe(false);
  });

  it('si el destino ya tiene un fichero distinto, no lo pisa: lo aparta a _conflictos', () => {
    const state = estadoViejo();
    const mem = join(state, 'memoria');
    mkdirSync(mem);
    writeFileSync(join(mem, 'PERFIL.md'), 'editado a mano\n');
    const r = migrarMemoriaACarpeta(state, mem);
    expect(r.conflictos).toBe(1);
    expect(readFileSync(join(mem, 'PERFIL.md'), 'utf8')).toBe('editado a mano\n');
    expect(readdirSync(join(mem, '_conflictos'))).toEqual(['snapshot-PERFIL.md']);
    expect(readFileSync(join(mem, '_conflictos', 'snapshot-PERFIL.md'), 'utf8')).toBe(
      'Le gusta el café solo\n',
    );
  });

  it('sin memoria vieja solo deja la marca', () => {
    const state = mkdtempSync(join(tmpdir(), 'mem8mig-'));
    const r = migrarMemoriaACarpeta(state, join(state, 'memoria'));
    expect(r.hecho).toBe(false);
    expect(existsSync(join(state, 'memoria', '.migrado.json'))).toBe(true);
    expect(existsSync(join(state, 'memoria-copia'))).toBe(false);
  });
});

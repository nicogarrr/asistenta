// memoria-temas-1: los hechos viven en notas/<tema>.md (salud, trabajo, casa…),
// no en un fichero por chat; los ficheros por chat se reparten una vez sin perder nada.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, memoryFile } from '../src/memory.js';
import { clasificarTema, normalizarTema } from '../src/memory/temas.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const DM = 'telegram:dm:42#main';
const GRUPO = 'telegram:group:-100#main';
const nuevaCarpeta = (): string =>
  join(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'temas-')), 'notas');

describe('clasificador local de temas', () => {
  it('reconoce temas por palabras clave y cae en general', () => {
    expect(clasificarTema('Tiene cita con el médico el martes')).toBe('salud');
    expect(clasificarTema('La ITV del coche caduca en marzo')).toBe('coches');
    expect(clasificarTema('Paga el alquiler del piso el día 5')).toBe('casa');
    expect(clasificarTema('Invierte en un fondo indexado con su banco')).toBe('finanzas');
    expect(clasificarTema('Trabaja en GerarAI')).toBe('gerarai');
    expect(clasificarTema('Le gusta el café solo')).toBe('general');
    expect(clasificarTema('algo', ['musica'])).toBe('musica');
  });
  it('normaliza nombres de tema seguros para Windows', () => {
    expect(normalizarTema('Música')).toBe('musica');
    expect(normalizarTema('../etc')).toBe('etc');
    expect(normalizarTema('CON')).toBeNull();
    expect(normalizarTema('indice')).toBeNull();
  });
});

describe('MemoryStore por temas', () => {
  it('escribe cada hecho en notas/<tema>.md con su chat, y lo lee solo en su chat', () => {
    const dir = nuevaCarpeta();
    const m = new MemoryStore(dir, { porTema: true });
    const a = m.remember(DM, 'Tiene cita con el médico el martes');
    m.remember(DM, 'Le gusta el café solo');
    m.remember(DM, 'Nota elegida a mano', { tema: 'Trabajo' });
    m.remember(GRUPO, 'El grupo queda en el gimnasio los lunes');
    const salud = readFileSync(join(dir, 'salud.md'), 'utf8');
    expect(salud.startsWith('# Notas: salud\n')).toBe(true);
    expect(salud).toContain(`[${a.id}]`);
    expect(salud).toContain('chat: telegram:dm:42#main');
    expect(readFileSync(join(dir, 'general.md'), 'utf8')).toContain('café solo');
    expect(readFileSync(join(dir, 'trabajo.md'), 'utf8')).toContain('Nota elegida a mano');
    expect(existsSync(memoryFile(dir, DM))).toBe(false);
    expect(m.all(DM).map((e) => e.text)).toHaveLength(3);
    expect(m.all(GRUPO).map((e) => e.text)).toEqual(['El grupo queda en el gimnasio los lunes']);
    expect(m.get(DM, a.id)?.tema).toBe('salud');
    expect(m.scopes()).toEqual([GRUPO, DM].sort());
    expect(m.temas()).toEqual([
      { tema: 'general', hechos: 1 },
      { tema: 'salud', hechos: 2 },
      { tema: 'trabajo', hechos: 1 },
    ]);
    expect(m.temas([DM]).find((t) => t.tema === 'salud')?.hechos).toBe(1);
  });

  it('olvidar, corregir y sustituir tocan solo la línea de ese chat', () => {
    const dir = nuevaCarpeta();
    const m = new MemoryStore(dir, { porTema: true });
    const a = m.remember(DM, 'Pesa 80 kilos');
    m.remember(GRUPO, 'Alguien del grupo pesa 70 kilos');
    const b = m.supersede(DM, a.id, 'Ahora 78');
    expect(m.get(DM, b.id)?.tema).toBe('salud');
    expect(m.get(DM, a.id)?.supersededBy).toBe(b.id);
    expect(m.forget(DM, b.id)).toBe(true);
    expect(m.all(GRUPO)).toHaveLength(1);
    expect(m.clear(DM)).toBe(1);
    const salud = readFileSync(join(dir, 'salud.md'), 'utf8');
    expect(salud).toContain('Alguien del grupo');
    expect(salud).not.toContain('80 kilos');
  });

  it('una línea escrita a mano sin chat es del chat por defecto y el texto a mano se respeta', () => {
    const dir = nuevaCarpeta();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'casa.md'),
      '# Casa\n\nMis apuntes a mano.\n- [h1] (2026-11-01) La caldera es Junkers\n',
    );
    const m = new MemoryStore(dir, { porTema: true, ambitoSinChat: DM });
    expect(m.all(DM).map((e) => e.id)).toEqual(['h1']);
    m.remember(DM, 'El casero se llama Paco');
    const casa = readFileSync(join(dir, 'casa.md'), 'utf8');
    expect(casa).toContain('Mis apuntes a mano.');
    expect(casa).toContain('La caldera es Junkers');
    expect(casa).toContain('El casero se llama Paco');
  });

  it('la pasada nocturna saca de general lo que ya tiene tema, sin perder el hecho', () => {
    const dir = nuevaCarpeta();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'general.md'),
      `# Notas: general\n\n- [g1] (2026-11-01, chat: ${DM}) Renovar la ITV del coche\n- [g2] (2026-11-01, chat: ${DM}) Le gusta el té\n`,
    );
    const m = new MemoryStore(dir, { porTema: true });
    expect(m.reclasificar()).toBe(1);
    expect(readFileSync(join(dir, 'coches.md'), 'utf8')).toContain('[g1]');
    expect(readFileSync(join(dir, 'general.md'), 'utf8')).not.toContain('[g1]');
    expect(
      m
        .all(DM)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['g1', 'g2']);
  });
});

describe('migración de notas por chat a temas', () => {
  it('reparte cada fichero por chat sin perder ningún hecho y deja copia byte a byte', () => {
    const dir = nuevaCarpeta();
    // Formato antiguo: un fichero por chat.
    const viejo = new MemoryStore(dir);
    const ids = [
      viejo.remember(DM, 'Alergia a la penicilina', { tags: ['salud'] }).id,
      viejo.remember(DM, 'Su jefe se llama Luis').id,
      viejo.remember(DM, 'Prefiere respuestas cortas').id,
      viejo.remember(GRUPO, 'El concierto es el sábado').id,
    ];
    const antes = {
      dm: readFileSync(memoryFile(dir, DM)),
      grupo: readFileSync(memoryFile(dir, GRUPO)),
    };
    const m = new MemoryStore(dir, { porTema: true });
    expect(existsSync(memoryFile(dir, DM))).toBe(false);
    expect(existsSync(memoryFile(dir, GRUPO))).toBe(false);
    expect(
      m
        .all(DM)
        .map((e) => e.id)
        .sort(),
    ).toEqual(ids.slice(0, 3).sort());
    expect(m.all(GRUPO).map((e) => e.id)).toEqual([ids[3]]);
    expect(readFileSync(join(dir, 'salud.md'), 'utf8')).toContain('Alergia a la penicilina');
    expect(readFileSync(join(dir, 'trabajo.md'), 'utf8')).toContain('Su jefe se llama Luis');
    expect(readFileSync(join(dir, 'musica.md'), 'utf8')).toContain('El concierto es el sábado');
    // Cada línea de hecho de los ficheros viejos sigue, entera, en algún tema.
    const temas = readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => readFileSync(join(dir, n), 'utf8'))
      .join('\n');
    for (const buf of [antes.dm, antes.grupo]) {
      for (const line of buf
        .toString('utf8')
        .split('\n')
        .filter((l) => l.startsWith('- ['))) {
        const texto = line.slice(line.indexOf(') ') + 2);
        expect(temas).toContain(texto);
      }
    }
    // Copia intacta de los originales.
    const copias = join(dir, '_copia-por-chat');
    const stamp = readdirSync(copias).find((n) => n !== 'retirados');
    expect(stamp).toBeDefined();
    const copiados = readdirSync(join(copias, stamp ?? '')).map((n) =>
      readFileSync(join(copias, stamp ?? '', n)),
    );
    expect(copiados.some((b) => b.equals(antes.dm))).toBe(true);
    expect(copiados.some((b) => b.equals(antes.grupo))).toBe(true);
    // Abrirla otra vez no repite nada.
    const otra = new MemoryStore(dir, { porTema: true });
    expect(otra.all(DM)).toHaveLength(3);
  });
});

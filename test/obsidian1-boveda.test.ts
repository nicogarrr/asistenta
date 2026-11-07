// obsidian-1 (Nico, 7 nov, tuit de @_DavidGF): la carpeta de memoria como bóveda de
// Obsidian. Propiedades YAML, [[enlaces]] entre temas, índice enlazado, acción
// `enlaces` (enlaces y enlaces inversos) y PA_OBSIDIAN_VAULT. Y lo más importante:
// lo que Nico edite en Obsidian no se pisa nunca, ni aunque escriba a la vez.
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
import { fusionarHechos, MemoryStore } from '../src/memory.js';
import { escribirIndiceMemoria, MARCA_INDICE_LIBRE } from '../src/memory/carpeta.js';
import {
  AVISO_MOVIDA,
  copiasDuplicadas,
  enlacesDeTexto,
  fijarPropiedades,
  indiceEnlaces,
  llevarMemoriaABoveda,
  obsidianActivo,
  resolverEnlace,
  separarFrontmatter,
  textoObsidian,
} from '../src/memory/obsidian.js';
import { elegirBoveda } from '../src/paths.js';
import { helpCommands } from '../src/channels/telegram-help.js';
import { OWNER_ONLY_COMMANDS } from '../src/funciones.js';
import { codificarChat } from '../src/memory/temas.js';
import { createMemoryTool } from '../src/tools/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const DM = 'telegram:dm:42#main';
const GRUPO = 'telegram:-100#main';
const carpeta = (): string => {
  const dir = join(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'obsidian1-')), 'memoria');
  mkdirSync(join(dir, 'notas'), { recursive: true });
  return dir;
};
const abrir = (dir: string, extra: Record<string, unknown> = {}): MemoryStore =>
  new MemoryStore(join(dir, 'notas'), {
    porTema: true,
    obsidian: true,
    ambitoSinChat: DM,
    boveda: dir,
    ...extra,
  });
const leer = (dir: string, tema: string): string =>
  readFileSync(join(dir, 'notas', `${tema}.md`), 'utf8');
const escribir = (dir: string, tema: string, texto: string): void =>
  writeFileSync(join(dir, 'notas', `${tema}.md`), texto, 'utf8');
const texto = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('\n');
const enlaces = async (s: MemoryStore, scope: string, query: string): Promise<string> =>
  texto(
    await createMemoryTool(s, () => scope).execute(
      't',
      { action: 'enlaces', query } as never,
      undefined as never,
      undefined as never,
    ),
  );

describe('notas de tema válidas para Obsidian', () => {
  it('propiedades (tags, updated, caduca), título, «Relacionado» y los hechos', () => {
    const dir = carpeta();
    const m = abrir(dir);
    m.remember(DM, 'Revisión de la tensión', { tema: 'salud', caduca: '2099-02-01' });
    m.remember(DM, 'Análisis de sangre', { tema: 'salud', caduca: '2099-01-05' });
    const t = leer(dir, 'salud');
    const { fm, cuerpo } = separarFrontmatter(t.split('\n'));
    expect(fm).not.toBeNull();
    expect(fm).toContain('tags:');
    expect(fm).toContain('  - asistenta');
    expect(fm).toContain('  - memoria/salud');
    expect(fm?.some((l) => /^updated: \d{4}-\d{2}-\d{2}$/.test(l))).toBe(true);
    // La caducidad más próxima de lo vigente.
    expect(fm).toContain('caduca: 2099-01-05');
    expect(cuerpo[0]).toBe('# Notas: salud');
    expect(cuerpo).toContain('Relacionado: [[indice|Índice]] %%auto%%');
    // Los hechos se siguen leyendo igual; las propiedades no son hechos.
    expect(m.all(DM).map((e) => e.text)).toEqual(['Revisión de la tensión', 'Análisis de sangre']);
    expect(m.temas()).toEqual([{ tema: 'salud', hechos: 2 }]);
  });

  it('enlaza temas relacionados: una etiqueta o una mención de otro tema', () => {
    const dir = carpeta();
    const m = abrir(dir);
    m.remember(DM, 'Reunión de equipo los lunes', { tema: 'agenda' });
    m.remember(DM, 'Cita con el dentista el jueves', { tema: 'salud', tags: ['agenda'] });
    expect(leer(dir, 'salud')).toContain('Relacionado: [[agenda]] · [[indice|Índice]] %%auto%%');
    m.remember(DM, 'Apuntar en la agenda el ITV', { tema: 'coches' });
    expect(leer(dir, 'coches')).toContain('[[agenda]]');
  });

  it('sin la opción obsidian el formato es el de siempre', () => {
    const dir = carpeta();
    const m = new MemoryStore(join(dir, 'notas'), { porTema: true });
    m.remember(DM, 'Le encanta Spotify', { tema: 'musica' });
    expect(leer(dir, 'musica').startsWith('# Notas: musica\n\n- [')).toBe(true);
    expect(obsidianActivo({})).toBe(true);
    expect(obsidianActivo({ PA_OBSIDIAN: '0' })).toBe(false);
  });

  it('prepararObsidian convierte notas viejas sin tocar los hechos, y es idempotente', () => {
    const dir = carpeta();
    const viejo = new MemoryStore(join(dir, 'notas'), { porTema: true, ambitoSinChat: DM });
    viejo.remember(DM, 'Prefiere el café solo', { tema: 'comida' });
    const antes = leer(dir, 'comida');
    const m = abrir(dir);
    expect(m.prepararObsidian()).toBe(1);
    const despues = leer(dir, 'comida');
    expect(despues.startsWith('---\n')).toBe(true);
    const hecho = antes.split('\n').find((l) => l.startsWith('- ['));
    expect(despues).toContain(hecho);
    expect(m.prepararObsidian()).toBe(0);
    expect(leer(dir, 'comida')).toBe(despues);
  });
});

describe('lo que Nico edita en Obsidian se conserva', () => {
  it('sus propiedades, etiquetas, alias, texto y enlaces sobreviven a las escrituras', () => {
    const dir = carpeta();
    const m = abrir(dir);
    m.remember(DM, 'Alergia a la penicilina', { tema: 'salud' });
    const t = leer(dir, 'salud')
      .replace('tags:\n', 'aliases: [Médico, Salud]\ncssclasses: ancha\ntags:\n  - personal\n')
      .concat('\nMis apuntes: preguntar a [[Ana]] por el seguro.\n');
    escribir(dir, 'salud', t);
    m.remember(DM, 'Va al fisio los martes', { tema: 'salud' });
    const d = leer(dir, 'salud');
    expect(d).toContain('aliases: [Médico, Salud]');
    expect(d).toContain('cssclasses: ancha');
    expect(d).toContain('  - personal');
    expect(d).toContain('  - asistenta');
    expect(d).toContain('Mis apuntes: preguntar a [[Ana]] por el seguro.');
    expect(m.all(DM).map((e) => e.text)).toEqual([
      'Alergia a la penicilina',
      'Va al fisio los martes',
    ]);
  });

  it('un hecho que corrige a mano en Obsidian es el que vale después', () => {
    const dir = carpeta();
    const m = abrir(dir);
    m.remember(DM, 'El coche es un Seat Ibiza', { tema: 'coches' });
    escribir(dir, 'coches', leer(dir, 'coches').replace('Seat Ibiza', 'Seat León'));
    m.remember(DM, 'La ITV es en marzo', { tema: 'coches' });
    expect(leer(dir, 'coches')).toContain('El coche es un Seat León');
    expect(leer(dir, 'coches')).not.toContain('Ibiza');
    expect(m.recall(DM, 'León').map((e) => e.text)).toContain('El coche es un Seat León');
  });

  it('si edita JUSTO mientras Asistenta escribe, su cambio no se pisa', () => {
    const dir = carpeta();
    let tocar: (() => void) | null = null;
    const m = abrir(dir, {
      trasLeer: () => {
        const f = tocar;
        tocar = null;
        f?.();
      },
    });
    const a = m.remember(DM, 'El coche es un Seat Ibiza', { tema: 'coches' });
    const b = m.remember(DM, 'Seguro con Mapfre', { tema: 'coches' });
    // Entre la lectura y la escritura: corrige un hecho, borra otro y añade uno suyo.
    tocar = () => {
      const t = leer(dir, 'coches')
        .replace('Seat Ibiza', 'Seat León')
        .split('\n')
        .filter((l) => !l.includes(`[${b.id}]`))
        .join('\n')
        .concat(`- [nico1] (2026-11-07, chat: ${codificarChat(DM)}) Tiene garaje\n`);
      escribir(dir, 'coches', t);
    };
    m.remember(DM, 'La ITV es en marzo', { tema: 'coches' });
    expect(tocar).toBeNull();
    const d = leer(dir, 'coches');
    expect(d).toContain(`[${a.id}]`);
    expect(d).toContain('Seat León');
    expect(d).not.toContain('Seat Ibiza');
    expect(d).not.toContain('Mapfre');
    expect(d).toContain('Tiene garaje');
    expect(d).toContain('La ITV es en marzo');
  });

  it('fusionarHechos: lo no tocado se queda como lo dejó él; lo nuestro, como lo dejamos', () => {
    const e = (id: string, text: string) => ({
      id,
      date: '2026-11-07',
      text,
      tags: [],
      supersedes: [],
      supersededBy: null,
      tema: 'x',
    });
    const base = new Map(
      [e('a', 'uno'), e('b', 'dos'), e('c', 'tres')].map((x) => [
        x.id,
        `- [${x.id}] (2026-11-07) ${x.text}\u0000x`,
      ]),
    );
    const nuestros = [e('a', 'uno'), e('b', 'DOS nuestro'), e('c', 'tres'), e('n', 'nuevo')];
    const suyos = [e('a', 'UNO suyo'), e('b', 'dos'), e('z', 'suyo nuevo')];
    expect(fusionarHechos(base, nuestros, suyos).map((x) => x.text)).toEqual([
      'UNO suyo',
      'DOS nuestro',
      'nuevo',
      'suyo nuevo',
    ]);
  });

  it('un tema vacío con propiedades suyas no se borra; uno solo nuestro, sí', () => {
    const dir = carpeta();
    const m = abrir(dir);
    const a = m.remember(DM, 'Le gusta el jazz', { tema: 'musica' });
    const b = m.remember(DM, 'Juega al pádel', { tema: 'deporte' });
    escribir(dir, 'musica', leer(dir, 'musica').replace('tags:\n', 'favorito: true\ntags:\n'));
    m.forget(DM, a.id);
    m.forget(DM, b.id);
    expect(existsSync(join(dir, 'notas', 'musica.md'))).toBe(true);
    expect(leer(dir, 'musica')).toContain('favorito: true');
    expect(existsSync(join(dir, 'notas', 'deporte.md'))).toBe(false);
  });

  it('fijarPropiedades respeta etiquetas en línea y el orden de sus claves', () => {
    expect(
      fijarPropiedades(['title: Hola', 'tags: [personal, "viaje"]', 'updated: 2020-01-01'], {
        tags: ['asistenta', 'memoria/viaje', 'personal'],
        updated: '2026-11-07',
        caduca: null,
      }),
    ).toEqual([
      'title: Hola',
      'tags:',
      '  - personal',
      '  - viaje',
      '  - asistenta',
      '  - memoria/viaje',
      'updated: 2026-11-07',
    ]);
  });
});

describe('índice enlazado', () => {
  it('enlaza perfil, episodios y temas con [[ ]] y conserva lo de debajo de la marca', () => {
    const dir = carpeta();
    const m = abrir(dir, { alEscribir: () => escribirIndiceMemoria(dir) });
    m.remember(DM, 'Le encanta Spotify', { tema: 'musica' });
    mkdirSync(join(dir, 'episodios'), { recursive: true });
    writeFileSync(join(dir, 'episodios', '2026-11-07.md'), '# Episodios\n');
    escribirIndiceMemoria(dir);
    const i = readFileSync(join(dir, 'indice.md'), 'utf8');
    expect(i.startsWith('---\ntags:\n  - asistenta\n')).toBe(true);
    expect(i).toContain('- [[notas/musica.md|musica]] — 1 hecho');
    expect(i).toContain('- [[episodios/2026-11-07.md|2026-11-07]]');
    expect(i).toContain(MARCA_INDICE_LIBRE);
    writeFileSync(join(dir, 'indice.md'), `${i}Mis cosas: [[Ana]]\n`);
    m.remember(DM, 'Odia el reguetón', { tema: 'musica' });
    const j = readFileSync(join(dir, 'indice.md'), 'utf8');
    expect(j).toContain('— 2 hechos');
    expect(j).toContain('Mis cosas: [[Ana]]');
  });

  it('un indice.md escrito del todo a mano se guarda aparte antes de rehacerlo', () => {
    const dir = carpeta();
    writeFileSync(join(dir, 'indice.md'), 'Mi índice personal\n');
    escribirIndiceMemoria(dir, new Date(2026, 10, 7));
    const copia = readdirSync(dir).find((n) => n.startsWith('indice.editado-'));
    expect(copia).toBeDefined();
    expect(readFileSync(join(dir, copia ?? ''), 'utf8')).toBe('Mi índice personal\n');
  });
});

describe('acción enlaces (como los backlinks de Obsidian)', () => {
  it('lee enlaces y enlaces inversos del disco, incluidas las notas de Nico', async () => {
    const dir = carpeta();
    const m = abrir(dir);
    m.remember(DM, 'Reunión los lunes', { tema: 'agenda' });
    m.remember(DM, 'Dentista el jueves', { tema: 'salud', tags: ['agenda'] });
    m.remember(GRUPO, 'El grupo queda el viernes en [[agenda]]', { tema: 'agenda' });
    writeFileSync(
      join(dir, 'Diario.md'),
      '---\naliases: [Mi diario]\n---\nHoy toca [[salud]] y [[Ana]].\n',
    );
    const s = await enlaces(m, DM, 'salud');
    expect(s).toContain('📄 notas/salud.md');
    expect(s).toContain('[[agenda]] → notas/agenda.md');
    expect(s).toContain('Diario.md:4: Hoy toca [[salud]] y [[Ana]].');
    const d = await enlaces(m, DM, 'Mi diario');
    expect(d).toContain('📄 Diario.md');
    expect(d).toContain('[[Ana]] → (no existe todavía)');
    const ag = await enlaces(m, DM, 'agenda');
    expect(ag).toContain('notas/salud.md');
    // Los hechos de otro chat no salen en el chat del dueño.
    expect(ag).not.toContain('El grupo queda');
    // Un cambio en Obsidian se ve en la siguiente llamada (sin caché).
    writeFileSync(join(dir, 'Viaje.md'), 'Ver [[agenda]]\n');
    expect(await enlaces(m, DM, 'agenda')).toContain('Viaje.md:1: Ver [[agenda]]');
  });

  it('en un grupo no se ven las notas de Nico ni lo de otros chats', async () => {
    const dir = carpeta();
    const m = abrir(dir);
    m.remember(DM, 'Secreto del dueño sobre [[agenda]]', { tema: 'salud' });
    m.remember(GRUPO, 'Quedada el viernes', { tema: 'agenda' });
    writeFileSync(join(dir, 'Diario.md'), 'Mi diario habla de [[agenda]]\n');
    const g = await enlaces(m, GRUPO, 'agenda');
    expect(g).toContain('📄 notas/agenda.md');
    expect(g).toContain('Enlazada desde (0)');
    expect(g).not.toContain('Diario');
    expect(g).not.toContain('salud');
    expect(await enlaces(m, GRUPO, 'Diario')).toContain('No hay ninguna nota');
    // Una nota donde el grupo no tiene nada no existe para él.
    expect(await enlaces(m, GRUPO, 'salud')).toContain('No hay ninguna nota');
  });

  it('resuelve como Obsidian: ruta, nombre, alias, #apartado e |texto; ignora código', () => {
    expect(
      enlacesDeTexto('a [[x#h|t]] ![[img.png]] `[[no]]`\n```\n[[tampoco]]\n```').map(
        (e) => e.destino,
      ),
    ).toEqual(['x', 'img.png']);
    const dir = carpeta();
    mkdirSync(join(dir, 'otra'), { recursive: true });
    writeFileSync(join(dir, 'notas', 'salud.md'), '# s\n');
    writeFileSync(join(dir, 'otra', 'salud.md'), '# otra\n');
    mkdirSync(join(dir, '.obsidian'), { recursive: true });
    writeFileSync(join(dir, '.obsidian', 'x.md'), '[[salud]]\n');
    const idx = indiceEnlaces(dir);
    expect(idx.notas.map((n) => n.ruta)).not.toContain('.obsidian/x.md');
    expect(resolverEnlace(idx, 'otra/salud')?.ruta).toBe('otra/salud.md');
    expect(resolverEnlace(idx, 'notas/salud.md')?.ruta).toBe('notas/salud.md');
    const desdeOtra = idx.notas.find((n) => n.ruta === 'otra/salud.md');
    expect(resolverEnlace(idx, 'Salud', desdeOtra)?.ruta).toBe('otra/salud.md');
  });
});

describe('PA_OBSIDIAN_VAULT', () => {
  it('elige <bóveda>/Asistenta solo si es una ruta completa que existe', () => {
    const st = '/estado';
    expect(elegirBoveda({}, st, '/home/n', () => true)).toEqual({
      memoria: '/estado/memoria',
      boveda: '/estado/memoria',
      pedida: null,
      motivo: null,
    });
    const ok = elegirBoveda({ PA_OBSIDIAN_VAULT: '/v/Notas' }, st, '/home/n', () => true);
    expect(ok.memoria).toBe(join('/v/Notas', 'Asistenta'));
    expect(ok.boveda).toBe('/v/Notas');
    const rel = elegirBoveda({ PA_OBSIDIAN_VAULT: 'Notas' }, st, '/home/n', () => true);
    expect(rel.memoria).toBe('/estado/memoria');
    expect(rel.motivo).toContain('ruta completa');
    const falta = elegirBoveda({ PA_OBSIDIAN_VAULT: '/no/esta' }, st, '/home/n', () => false);
    expect(falta.memoria).toBe('/estado/memoria');
    expect(falta.motivo).toContain('no existe');
    const win = elegirBoveda(
      {
        PA_OBSIDIAN_VAULT: '"%USERPROFILE%\\iCloudDrive\\iCloud~md~obsidian\\Asistenta"',
        USERPROFILE: 'C:\\Users\\nico',
      },
      st,
      '/home/n',
      () => true,
    );
    expect(win.pedida).toBe('C:\\Users\\nico\\iCloudDrive\\iCloud~md~obsidian\\Asistenta');
    expect(win.motivo).toBeNull();
  });

  it('la primera vez copia la memoria a la bóveda byte a byte y deja aviso; nunca mezcla', () => {
    const base = mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'obsidian1-v-'));
    const origen = join(base, 'memoria');
    mkdirSync(join(origen, 'notas'), { recursive: true });
    writeFileSync(
      join(origen, 'notas', 'salud.md'),
      '# Notas: salud\n\n- [a] (2026-11-07) Alergia\n',
    );
    writeFileSync(join(origen, 'indice.md'), '# Índice\n');
    const destino = join(base, 'Boveda', 'Asistenta');
    expect(llevarMemoriaABoveda(origen, destino)).toEqual({ copiados: 2, omitido: null });
    expect(readFileSync(join(destino, 'notas', 'salud.md'), 'utf8')).toContain('Alergia');
    expect(readFileSync(join(origen, AVISO_MOVIDA), 'utf8')).toContain(destino);
    // La original se queda como copia.
    expect(existsSync(join(origen, 'notas', 'salud.md'))).toBe(true);
    // Si la bóveda ya tiene memoria no se copia nada encima.
    writeFileSync(join(origen, 'notas', 'salud.md'), 'cambiado\n');
    expect(llevarMemoriaABoveda(origen, destino).omitido).toBe('la bóveda ya tiene memoria');
    expect(readFileSync(join(destino, 'notas', 'salud.md'), 'utf8')).toContain('Alergia');
  });

  it('detecta las copias duplicadas que crea iCloud al chocar', () => {
    const dir = carpeta();
    for (const n of ['salud.md', 'salud 2.md', 'agenda (1).md', 'coches.sync-conflict-20261107.md'])
      writeFileSync(join(dir, 'notas', n), 'x\n');
    expect(copiasDuplicadas(join(dir, 'notas'))).toEqual([
      'agenda (1).md',
      'coches.sync-conflict-20261107.md',
      'salud 2.md',
    ]);
  });
});

describe('/obsidian', () => {
  it('sale en /help y es solo del dueño', () => {
    expect(helpCommands()).toContain('obsidian');
    expect(OWNER_ONLY_COMMANDS.has('obsidian')).toBe(true);
  });

  it('pasos cortos para el PC y el iPhone gratis, con la ruta y los avisos', () => {
    const t = textoObsidian({
      memoria: 'C:\\Users\\nico\\.local\\share\\personal-agent\\memoria',
      pedida: null,
      motivo: null,
      activo: true,
      duplicados: [],
    });
    expect(t).toContain('C:\\Users\\nico\\.local\\share\\personal-agent\\memoria');
    expect(t).toContain('Abrir carpeta como bóveda');
    expect(t).toContain('Guardar en iCloud');
    expect(t).toContain('iCloud~md~obsidian');
    expect(t).toContain('PA_OBSIDIAN_VAULT');
    expect(t).toContain('Obsidian Sync es de pago');
    const mal = textoObsidian({
      memoria: '/m',
      pedida: 'D:\\nada',
      motivo: 'esa carpeta no existe en este PC',
      activo: false,
      duplicados: ['salud 2.md'],
    });
    expect(mal).toContain('no se usa: esa carpeta no existe en este PC');
    expect(mal).toContain('PA_OBSIDIAN=0');
    expect(mal).toContain('salud 2.md');
  });
});

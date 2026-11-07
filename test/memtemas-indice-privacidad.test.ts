// memoria-temas-1: índice con cuentas por tema, /memoria por temas, herramienta con
// `tema`, diario solo del chat privado del dueño, perfil v2 reflejado en la carpeta
// y /borrar_chat que también limpia las notas por tema.
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
import { MemoryStore } from '../src/memory.js';
import {
  episodioPermitido,
  escribirIndiceMemoria,
  resumenCarpetaMemoria,
  textoCarpetaMemoria,
} from '../src/memory/carpeta.js';
import { ESPEJO_PERFIL, OwnerProfile } from '../src/memory/profile.js';
import { textoMemoriaPorTemas, textoTemaMemoria } from '../src/memory/temas-comando.js';
import { eraseScope } from '../src/maintenance.js';
import { createMemoryTool } from '../src/tools/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const DM = 'telegram:dm:42#main';
const OTRO = 'telegram:dm:7#main';
const carpeta = (): string => {
  const dir = join(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'temas2-')), 'memoria');
  mkdirSync(join(dir, 'notas'), { recursive: true });
  return dir;
};

describe('indice.md con temas y cuentas', () => {
  it('lista cada tema con sus hechos vigentes', () => {
    const dir = carpeta();
    const m = new MemoryStore(join(dir, 'notas'), { porTema: true });
    const a = m.remember(DM, 'Cita con el dentista el jueves');
    m.supersede(DM, a.id, 'Cita con el dentista el viernes');
    m.remember(DM, 'La ITV del coche es en marzo');
    m.remember(OTRO, 'Mi coche es rojo');
    escribirIndiceMemoria(dir, new Date(2026, 10, 7));
    const indice = readFileSync(join(dir, 'indice.md'), 'utf8');
    expect(indice).toContain('- [[notas/coches.md|coches]] — 2 hechos');
    expect(indice).toContain('- [[notas/salud.md|salud]] — 1 hecho');
    expect(textoCarpetaMemoria(resumenCarpetaMemoria(dir))).toContain(
      'notas por tema: coches (2), salud (1)',
    );
  });
  it('alEscribir rehace el índice en cada escritura', () => {
    const dir = carpeta();
    const m = new MemoryStore(join(dir, 'notas'), {
      porTema: true,
      alEscribir: () => escribirIndiceMemoria(dir),
    });
    m.remember(DM, 'Le encanta Spotify');
    expect(readFileSync(join(dir, 'indice.md'), 'utf8')).toContain(
      '[[notas/musica.md|musica]] — 1 hecho',
    );
  });
});

describe('/memoria por temas', () => {
  it('sin argumento agrupa por tema; con un tema enseña solo ese; nunca otro chat', () => {
    const dir = carpeta();
    const m = new MemoryStore(join(dir, 'notas'), { porTema: true });
    m.remember(DM, 'Alergia al polen');
    m.remember(DM, 'Su jefe es Luis');
    m.remember(OTRO, 'Secreto de otro chat sobre su médico');
    const todo = textoMemoriaPorTemas(m, [DM]) ?? '';
    expect(todo).toContain('por tema: salud (1), trabajo (1)');
    expect(todo).toContain('📂 salud (1)');
    expect(todo).not.toContain('otro chat');
    const salud = textoTemaMemoria(m, [DM], 'Salud') ?? '';
    expect(salud).toContain('memoria/notas/salud.md');
    expect(salud).toContain('Alergia al polen');
    expect(salud).not.toContain('Luis');
    expect(salud).not.toContain('otro chat');
    expect(textoTemaMemoria(m, [DM], 'casa')).toBeNull();
    expect(textoMemoriaPorTemas(m, ['telegram:dm:99#main'])).toBeNull();
  });
});

describe('herramienta memory con tema', () => {
  it('remember con tema lo guarda en ese fichero al momento', async () => {
    const dir = carpeta();
    const m = new MemoryStore(join(dir, 'notas'), { porTema: true });
    const tool = createMemoryTool(m, () => DM);
    const r = await tool.execute('c1', {
      action: 'remember',
      text: 'Prefiere Vinted',
      tema: 'amazon',
    });
    expect(r.details).toMatchObject({ tema: 'amazon' });
    expect(readFileSync(join(dir, 'notas', 'amazon.md'), 'utf8')).toContain('Prefiere Vinted');
  });
});

describe('diario (episodios) solo del chat privado del dueño', () => {
  const dm = { channel: 'telegram', chatId: '42', userId: '42', isGroup: false };
  const grupo = { channel: 'telegram', chatId: '-100', userId: '42', isGroup: true };
  const ajeno = { channel: 'telegram', chatId: '7', userId: '7', isGroup: false };
  it('por defecto: el DM del dueño sí, grupos y otros no', () => {
    expect(episodioPermitido(dm, 42, {})).toBe(true);
    expect(episodioPermitido(grupo, 42, {})).toBe(false);
    expect(episodioPermitido(ajeno, 42, {})).toBe(false);
    expect(episodioPermitido({ channel: 'web', chatId: 'panel', userId: 'panel' }, 42, {})).toBe(
      true,
    );
  });
  it('PA_MEMORY_EPISODIOS_GRUPOS=1 incluye los grupos', () => {
    expect(episodioPermitido(grupo, 42, { PA_MEMORY_EPISODIOS_GRUPOS: '1' })).toBe(true);
  });
});

describe('perfil v2 reflejado en la carpeta de memoria', () => {
  it('sobre-ti.md se crea al abrir y sigue cada cambio, sin perder el historial', () => {
    const dir = carpeta();
    const json = join(dir, '..', 'profile', '42.json');
    const espejo = join(dir, ESPEJO_PERFIL);
    const p = new OwnerProfile(json, { espejo });
    const a = p.add('Vive en Madrid');
    expect(readFileSync(espejo, 'utf8')).toContain('Vive en Madrid');
    p.update(a.id, { text: 'Vive en Valencia' });
    const texto = readFileSync(espejo, 'utf8');
    expect(texto).toContain('## Vigente (1)\n- (');
    expect(texto).toContain('Vive en Valencia');
    expect(texto).toContain('## Historial: sustituidos (1)');
    expect(texto).toContain('Vive en Madrid');
    // Abrir de nuevo con el JSON existente rehace un espejo borrado.
    const p2 = new OwnerProfile(json, { espejo: join(dir, 'otro-espejo.md') });
    expect(readFileSync(join(dir, 'otro-espejo.md'), 'utf8')).toContain('Vive en Valencia');
    expect(p2.load().length).toBeGreaterThan(0);
  });
  it('si Nico editó la copia a mano, su versión se guarda antes de rehacerla', () => {
    const dir = carpeta();
    const espejo = join(dir, ESPEJO_PERFIL);
    const p = new OwnerProfile(join(dir, '..', 'profile', '1.json'), { espejo });
    p.add('Le gusta el café');
    writeFileSync(espejo, `${readFileSync(espejo, 'utf8')}\nUna línea mía\n`);
    p.add('Tiene un gato');
    const editados = readdirSync(dir).filter((n) => n.startsWith('sobre-ti.editado-'));
    expect(editados).toHaveLength(1);
    expect(readFileSync(join(dir, editados[0] ?? ''), 'utf8')).toContain('Una línea mía');
    expect(readFileSync(espejo, 'utf8')).toContain('Tiene un gato');
  });
});

describe('/borrar_chat limpia las notas por tema', () => {
  it('eraseScope con la memoria viva borra los hechos de ese chat y deja los demás', () => {
    const dir = carpeta();
    const m = new MemoryStore(join(dir, 'notas'), { porTema: true });
    m.remember(DM, 'Alergia al polen');
    m.remember(OTRO, 'Alergia a los gatos');
    const r = eraseScope({ stateDir: join(dir, '..'), scope: DM, memory: m });
    expect(r.memoryFile).toBe(true);
    expect(m.all(DM)).toHaveLength(0);
    expect(m.all(OTRO)).toHaveLength(1);
    expect(existsSync(join(dir, 'notas', 'salud.md'))).toBe(true);
  });
});

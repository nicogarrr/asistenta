/**
 * The snapshot files (MEMORIA.md / PERFIL.md), the memory-worthy nudge and the
 * tool actions that expose both. Everything runs against a temp dir: a snapshot
 * that writes outside its dir is a bug worth failing over.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectMemoryWorthy } from '../src/memory/nudges.js';
import { MemorySnapshot } from '../src/memory/snapshot.js';
import { MemoryStore } from '../src/memory.js';
import { createMemoryTool } from '../src/tools/memory.js';

// Stubbed so a test run cannot append to the real daily log under the state dir.
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

let dir = '';
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-snapshot-'));
  store = new MemoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** The tool hands back a union of text and image blocks; only the text matters here. */
function textOf(result: { content: Array<{ type: string; text?: string } | unknown> }): string {
  return (result.content as Array<{ text?: string }>).map((c) => c?.text ?? '').join('\n');
}

describe('MemorySnapshot', () => {
  it('load crea los ficheros, devuelve vacíos y la segunda lectura es estable', () => {
    const snapshot = new MemorySnapshot({ dir });
    expect(snapshot.load()).toEqual({ memoria: '', perfil: '' });
    expect(existsSync(join(dir, 'MEMORIA.md'))).toBe(true);
    expect(existsSync(join(dir, 'PERFIL.md'))).toBe(true);
    expect(snapshot.load()).toEqual({ memoria: '', perfil: '' });
  });

  it('appendEntry respeta maxChars y elimina lo más viejo', () => {
    const snapshot = new MemorySnapshot({ dir, maxChars: 100 });
    const first = 'a'.repeat(30);
    const second = 'b'.repeat(30);
    const third = 'c'.repeat(30);
    const fourth = 'd'.repeat(30);
    snapshot.appendEntry('memoria', first);
    snapshot.appendEntry('memoria', second);
    snapshot.appendEntry('memoria', third);
    expect(snapshot.load().memoria).toBe([first, second, third].join('\n§\n'));
    snapshot.appendEntry('memoria', fourth);
    expect(snapshot.load().memoria).toBe([second, third, fourth].join('\n§\n'));
  });

  it('una entrada más larga que el cap se trunca en lugar de vaciar el fichero', () => {
    const snapshot = new MemorySnapshot({ dir, maxChars: 100 });
    snapshot.appendEntry('perfil', 'x'.repeat(250));
    expect(snapshot.load().perfil).toBe('x'.repeat(100));
  });

  it('contextNote formatea los bloques, omite los vacíos y devuelve vacío si no hay nada', () => {
    const snapshot = new MemorySnapshot({ dir });
    expect(snapshot.contextNote()).toBe('');
    snapshot.appendEntry('memoria', 'prefiere respuestas cortas');
    expect(snapshot.contextNote()).toBe('<memory>\nprefiere respuestas cortas\n</memory>');
    snapshot.appendEntry('perfil', 'se llama Ana');
    expect(snapshot.contextNote()).toBe(
      '<memory>\nprefiere respuestas cortas\n</memory>\n<profile>\nse llama Ana\n</profile>',
    );
  });

  it('saveMemoria corta en el último separador dentro del límite', () => {
    const snapshot = new MemorySnapshot({ dir, maxChars: 60 });
    const first = 'a'.repeat(20);
    const second = 'b'.repeat(20);
    const third = 'c'.repeat(20);
    snapshot.saveMemoria([first, second, third].join('\n§\n'));
    expect(snapshot.load().memoria).toBe([first, second].join('\n§\n'));
  });

  it('sin separador dentro del límite, savePerfil trunca', () => {
    const snapshot = new MemorySnapshot({ dir, maxChars: 60 });
    snapshot.savePerfil('y'.repeat(250));
    expect(snapshot.load().perfil).toBe('y'.repeat(60));
  });
});

describe('detectMemoryWorthy', () => {
  it('detecta preferencias y cita la cláusula que dispara', () => {
    const nudge = detectMemoryWorthy('prefiero los videos en 1080p');
    expect(nudge.worth).toBe(true);
    expect(nudge.suggestion).toBe(
      'Parece que revelaste algo duradero: "prefiero los videos en 1080p". ' +
        '¿Quieres que lo guarde en tu perfil?',
    );

    const buried = detectMemoryWorthy('hola, por cierto, prefiero los videos en 1080p, gracias');
    expect(buried.worth).toBe(true);
    expect(buried.suggestion).toContain('"prefiero los videos en 1080p"');
    expect(buried.suggestion).not.toContain('por cierto');
  });

  it('detecta datos personales', () => {
    const pets = detectMemoryWorthy('tengo dos gatos y vivo en Madrid desde hace años');
    expect(pets.worth).toBe(true);
    expect(pets.suggestion).toContain('"tengo dos gatos y vivo en Madrid desde hace años"');

    const name = detectMemoryWorthy('mi nombre es Ana y trabajo en Barcelona');
    expect(name.worth).toBe(true);
    expect(name.suggestion).toContain('"mi nombre es Ana y trabajo en Barcelona"');
  });

  it('detecta correcciones', () => {
    const rename = detectMemoryWorthy('en realidad me llamo Ana y no como os dije antes');
    expect(rename.worth).toBe(true);
    expect(rename.suggestion).toContain('"en realidad me llamo Ana y no como os dije antes"');

    const color = detectMemoryWorthy('el coche no es rojo sino azul, que es el que quería');
    expect(color.worth).toBe(true);
    expect(color.suggestion).toContain('"el coche no es rojo sino azul"');
  });

  it('detecta decisiones', () => {
    const plan = detectMemoryWorthy('he decidido que voy a correr por las mañanas');
    expect(plan.worth).toBe(true);
    expect(plan.suggestion).toContain('"he decidido que voy a correr por las mañanas"');

    const start = detectMemoryWorthy('el lunes empezaré a estudiar por las tardes');
    expect(start.worth).toBe(true);
    expect(start.suggestion).toContain('"el lunes empezaré a estudiar por las tardes"');
  });

  it('rechaza saludos', () => {
    expect(detectMemoryWorthy('hola, buenos días, ¿qué tal?')).toEqual({
      worth: false,
      suggestion: '',
    });
    expect(detectMemoryWorthy('muy buenas, ¿qué tal todo por ahí?')).toEqual({
      worth: false,
      suggestion: '',
    });
  });

  it('rechaza preguntas sin afirmación fuerte', () => {
    expect(detectMemoryWorthy('¿siempre llegas tarde a las reuniones?')).toEqual({
      worth: false,
      suggestion: '',
    });
    expect(detectMemoryWorthy('¿me puedes ayudar con la impresora del salón?')).toEqual({
      worth: false,
      suggestion: '',
    });
  });

  it('una pregunta con afirmación dentro sí merece nudge', () => {
    const nudge = detectMemoryWorthy('¿a qué hora quedamos? prefiero por la tarde, si te va bien');
    expect(nudge.worth).toBe(true);
    expect(nudge.suggestion).toContain('"prefiero por la tarde"');
  });

  it('rechaza textos cortos y lo que no revela nada durable', () => {
    expect(detectMemoryWorthy('me llamo Ana')).toEqual({ worth: false, suggestion: '' });
    expect(detectMemoryWorthy('ayer comí pasta en un sitio nuevo del centro')).toEqual({
      worth: false,
      suggestion: '',
    });
    expect(detectMemoryWorthy('')).toEqual({ worth: false, suggestion: '' });
  });
});

describe('memory tool con snapshot', () => {
  it('save_profile y profile pasan por el snapshot', async () => {
    const snapshot = new MemorySnapshot({ dir });
    const tool = createMemoryTool(store, () => 'telegram:main:1', snapshot);
    const saved = await tool.execute('c1', {
      action: 'save_profile',
      text: 'se llama Ana y vive en Madrid',
    });
    expect(saved.isError).toBeFalsy();
    expect(snapshot.load().perfil).toBe('se llama Ana y vive en Madrid');

    const profile = await tool.execute('c2', { action: 'profile' });
    expect(textOf(profile)).toContain('se llama Ana y vive en Madrid');
    expect(profile.isError).toBeFalsy();
  });

  it('suggest_nudge devuelve el nudge en español', async () => {
    const snapshot = new MemorySnapshot({ dir });
    const tool = createMemoryTool(store, () => 'telegram:main:1', snapshot);
    const nudge = await tool.execute('c3', {
      action: 'suggest_nudge',
      text: 'prefiero los videos en 1080p',
    });
    expect(nudge.details).toMatchObject({ worth: true });
    expect(textOf(nudge)).toContain('¿Quieres que lo guarde en tu perfil?');

    const quiet = await tool.execute('c4', {
      action: 'suggest_nudge',
      text: 'ayer comí pasta en un sitio nuevo del centro',
    });
    expect(quiet.details).toMatchObject({ worth: false });
    expect(textOf(quiet)).toContain('No parece que haya nada duradero');
  });

  it('remember y recall siguen funcionando', async () => {
    const snapshot = new MemorySnapshot({ dir });
    const tool = createMemoryTool(store, () => 'telegram:main:1', snapshot);
    const remembered = await tool.execute('c5', {
      action: 'remember',
      text: 'prefiere respuestas cortas',
    });
    expect(remembered.isError).toBeFalsy();
    const entry = store.all('telegram:main:1')[0];
    expect(entry?.text).toBe('prefiere respuestas cortas');

    const recalled = await tool.execute('c6', { action: 'recall', query: 'respuestas' });
    expect(recalled.details).toMatchObject({ count: 1 });

    const listed = await tool.execute('c7', { action: 'list' });
    expect(listed.details).toMatchObject({ count: 1 });

    const forgotten = await tool.execute('c8', { action: 'forget', id: String(entry?.id) });
    expect(forgotten.details).toMatchObject({ removed: true });
  });
});

describe('memory tool sin snapshot', () => {
  it('save_profile y profile devuelven un error controlado en el resultado', async () => {
    const tool = createMemoryTool(store, () => 'telegram:main:1');
    const saved = await tool.execute('d1', {
      action: 'save_profile',
      text: 'se llama Ana',
    });
    expect(saved.isError).toBe(true);
    expect(textOf(saved)).toContain('no está disponible');

    const profile = await tool.execute('d2', { action: 'profile' });
    expect(profile.isError).toBe(true);
  });

  it('suggest_nudge funciona siempre porque es puro', async () => {
    const tool = createMemoryTool(store, () => 'telegram:main:1');
    const nudge = await tool.execute('d3', {
      action: 'suggest_nudge',
      text: 'prefiero los videos en 1080p',
    });
    expect(nudge.isError).toBeFalsy();
    expect(nudge.details).toMatchObject({ worth: true });
    expect(textOf(nudge)).toContain('prefiero los videos en 1080p');
  });

  it('remember y recall siguen funcionando sin snapshot', async () => {
    const tool = createMemoryTool(store, () => 'telegram:main:1');
    await tool.execute('d4', { action: 'remember', text: 'prefiere respuestas cortas' });
    const recalled = await tool.execute('d5', { action: 'recall', query: 'respuestas' });
    expect(recalled.details).toMatchObject({ count: 1 });
  });
});

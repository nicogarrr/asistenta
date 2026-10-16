/**
 * The snapshot file (PERFIL.md), the memory-worthy nudge and the tool actions
 * that expose both. Everything runs against a temp dir: a snapshot that writes
 * outside its dir is a bug worth failing over.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectMemoryWorthy } from '../src/memory/nudges.js';
import { looksLikeSecret, MemorySnapshot } from '../src/memory/snapshot.js';
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
  it('load crea el fichero, devuelve vacío y la segunda lectura es estable', () => {
    const snapshot = new MemorySnapshot({ dir });
    expect(snapshot.load()).toBe('');
    expect(existsSync(join(dir, 'PERFIL.md'))).toBe(true);
    // MEMORIA.md se eliminó: era un escritor muerto (nadie la escribía en
    // runtime) con sitio en el prompt. No debe volver a crearse.
    expect(existsSync(join(dir, 'MEMORIA.md'))).toBe(false);
    expect(snapshot.load()).toBe('');
  });

  it('appendEntry respeta maxChars y elimina lo más viejo', () => {
    const snapshot = new MemorySnapshot({ dir, maxChars: 100 });
    const first = 'a'.repeat(30);
    const second = 'b'.repeat(30);
    const third = 'c'.repeat(30);
    const fourth = 'd'.repeat(30);
    snapshot.appendEntry(first);
    snapshot.appendEntry(second);
    snapshot.appendEntry(third);
    expect(snapshot.load()).toBe([first, second, third].join('\n§\n'));
    snapshot.appendEntry(fourth);
    expect(snapshot.load()).toBe([second, third, fourth].join('\n§\n'));
  });

  it('una entrada más larga que el cap se trunca en lugar de vaciar el fichero', () => {
    const snapshot = new MemorySnapshot({ dir, maxChars: 100 });
    snapshot.appendEntry('x'.repeat(250));
    expect(snapshot.load()).toBe('x'.repeat(100));
  });

  it('contextNote formatea el bloque y devuelve vacío si no hay nada', () => {
    const snapshot = new MemorySnapshot({ dir });
    expect(snapshot.contextNote()).toBe('');
    snapshot.appendEntry('se llama Ana');
    expect(snapshot.contextNote()).toBe('<profile>\nse llama Ana\n</profile>');
  });

  it('contextNote lee un MEMORIA.md legado sin crearlo ni escribirlo', () => {
    // Legado: el fichero era editable a mano, así que uno preexistente con
    // contenido se honra aunque ya nadie lo escriba.
    writeFileSync(join(dir, 'MEMORIA.md'), '# MEMORIA\n\nprefiere respuestas cortas', 'utf8');
    const snapshot = new MemorySnapshot({ dir });
    expect(snapshot.contextNote()).toBe('<memoria_legada>\nprefiere respuestas cortas\n</memoria_legada>');
    snapshot.appendEntry('se llama Ana');
    expect(snapshot.contextNote()).toBe(
      '<memoria_legada>\nprefiere respuestas cortas\n</memoria_legada>\n<profile>\nse llama Ana\n</profile>',
    );
    // Ni un byte cambiado: lectura estricta.
    expect(readFileSync(join(dir, 'MEMORIA.md'), 'utf8')).toBe(
      '# MEMORIA\n\nprefiere respuestas cortas',
    );
  });

  it('un MEMORIA.md legado vacío (solo plantilla) no emite bloque', () => {
    writeFileSync(join(dir, 'MEMORIA.md'), '# MEMORIA\n\n', 'utf8');
    const snapshot = new MemorySnapshot({ dir });
    expect(snapshot.contextNote()).toBe('');
  });

  it('savePerfil corta en el último separador dentro del límite', () => {
    const snapshot = new MemorySnapshot({ dir, maxChars: 60 });
    const first = 'a'.repeat(20);
    const second = 'b'.repeat(20);
    const third = 'c'.repeat(20);
    snapshot.savePerfil([first, second, third].join('\n§\n'));
    expect(snapshot.load()).toBe([first, second].join('\n§\n'));
  });

  it('sin separador dentro del límite, savePerfil trunca', () => {
    const snapshot = new MemorySnapshot({ dir, maxChars: 60 });
    snapshot.savePerfil('y'.repeat(250));
    expect(snapshot.load()).toBe('y'.repeat(60));
  });

  it('appendEntry rechaza una entrada con secreto y no la escribe en el fichero', () => {
    const snapshot = new MemorySnapshot({ dir });
    const result = snapshot.appendEntry('mi contraseña de la banca es 1234');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('contraseña');
    expect(result.error).toBeUndefined();
    expect(snapshot.load()).toBe('');
    expect(readFileSync(join(dir, 'PERFIL.md'), 'utf8')).not.toContain('1234');
    expect(readFileSync(join(dir, 'PERFIL.md'), 'utf8')).not.toContain('contraseña');
  });

  it('savePerfil rechaza secretos y devuelve el motivo', () => {
    const snapshot = new MemorySnapshot({ dir });
    const perfil = snapshot.savePerfil('password: x');
    expect(perfil.ok).toBe(false);
    expect(perfil.reason).toContain('contraseña');
    const token = snapshot.savePerfil(`sk-${'a'.repeat(20)}`);
    expect(token.ok).toBe(false);
    expect(token.reason).toContain('token');
    expect(snapshot.load()).toBe('');
  });

  it('un fallo de disco devuelve ok:false con error y no afirma éxito', () => {
    // A file where a directory must be: every write under it fails for real.
    writeFileSync(join(dir, 'bloqueo'), 'esto es un fichero, no un directorio', 'utf8');
    const snapshot = new MemorySnapshot({ dir: join(dir, 'bloqueo', 'sub') });
    const saved = snapshot.savePerfil('se llama Ana');
    expect(saved.ok).toBe(false);
    expect(saved.error).toBeTruthy();
    expect(saved.reason).toBeUndefined();
    const appended = snapshot.appendEntry('se llama Ana');
    expect(appended.ok).toBe(false);
    expect(appended.error).toBeTruthy();
    expect(appended.reason).toBeUndefined();
  });
});

describe('looksLikeSecret', () => {
  it('detecta números de tarjeta de 13 a 19 dígitos', () => {
    expect(looksLikeSecret('mi tarjeta es 4111 1111 1111 1111')).toContain('tarjeta');
    expect(looksLikeSecret('4111-1111-1111-1111')).toContain('tarjeta');
    expect(looksLikeSecret('1234567890123')).toContain('tarjeta');
    expect(looksLikeSecret('el pedido 1234 tarda dos días')).toBeNull();
  });

  it('detecta contraseñas y tokens con valor, pero no menciones sin valor', () => {
    expect(looksLikeSecret('password: x')).toContain('contraseña');
    expect(looksLikeSecret('mi contraseña de la banca es 1234')).toContain('contraseña');
    expect(looksLikeSecret('api_key=abc123')).toContain('contraseña');
    expect(looksLikeSecret('token: lo que sea')).toContain('contraseña');
    expect(looksLikeSecret('no me preguntes por contraseñas')).toBeNull();
    expect(looksLikeSecret('las contraseñas son peligrosas de guardar')).toBeNull();
    expect(looksLikeSecret('mi clave es simple de recordar')).toBeNull();
  });

  it('detecta claves privadas', () => {
    expect(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIEpq')).toContain('privada');
    expect(looksLikeSecret('-----BEGIN PRIVATE KEY-----abc')).toContain('privada');
  });

  it('detecta tokens con forma conocida', () => {
    expect(looksLikeSecret(`sk-${'a'.repeat(20)}`)).toContain('token');
    expect(looksLikeSecret(`ghp_${'a'.repeat(20)}`)).toContain('GitHub');
    expect(looksLikeSecret(`github_pat_${'a'.repeat(20)}`)).toContain('GitHub');
    expect(looksLikeSecret(`xoxb-${'a'.repeat(12)}`)).toContain('Slack');
    expect(looksLikeSecret(`AKIA${'A'.repeat(16)}`)).toContain('AWS');
    expect(looksLikeSecret(`AIza${'a'.repeat(35)}`)).toContain('Google');
    expect(
      looksLikeSecret('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'),
    ).toContain('JWT');
    expect(looksLikeSecret('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaws')).toContain('Telegram');
  });

  it('devuelve null para texto normal', () => {
    expect(looksLikeSecret('prefiero los videos en 1080p')).toBeNull();
    expect(looksLikeSecret('se llama Ana y vive en Madrid')).toBeNull();
    expect(looksLikeSecret('')).toBeNull();
  });
});

describe('detectMemoryWorthy', () => {
  it('does not nudge on requests or credentials (tanda 3 E2/E6/H2)', () => {
    expect(
      detectMemoryWorthy('Resúmeme el último correo que tengo y redacta una respuesta').worth,
    ).toBe(false);
    expect(
      detectMemoryWorthy('Tengo 40 euros: busca la mejor opción para ir de Oviedo a Madrid').worth,
    ).toBe(false);
    expect(detectMemoryWorthy('Guarda mi contraseña de Netflix, que es Tigre-9921-xyz').worth).toBe(
      false,
    );
    expect(detectMemoryWorthy('Tengo 40 euros al mes para ocio').worth).toBe(true);
    expect(detectMemoryWorthy('Mi cumpleaños es el 17 de marzo. Apúntalo.').worth).toBe(true);
  });

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
    expect(snapshot.load()).toBe('se llama Ana y vive en Madrid');

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

describe('memory tool reporta el resultado real', () => {
  it('save_profile dice explícitamente que NO está guardado cuando el disco falla', async () => {
    writeFileSync(join(dir, 'bloqueo'), 'esto es un fichero, no un directorio', 'utf8');
    const snapshot = new MemorySnapshot({ dir: join(dir, 'bloqueo', 'sub') });
    const tool = createMemoryTool(store, () => 'telegram:main:1', snapshot);
    const failed = await tool.execute('e1', { action: 'save_profile', text: 'se llama Ana' });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('No está guardado');
    expect(textOf(failed)).not.toContain('Guardado en tu perfil');
  });

  it('save_profile rechaza secretos con motivo y no dice que los guardó', async () => {
    const snapshot = new MemorySnapshot({ dir });
    const tool = createMemoryTool(store, () => 'telegram:main:1', snapshot);
    const rejected = await tool.execute('e2', {
      action: 'save_profile',
      text: 'mi contraseña de la banca es 1234',
    });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('No lo he guardado');
    expect(textOf(rejected)).toContain('contraseña');
    expect(textOf(rejected)).not.toContain('Guardado en tu perfil');
    expect(snapshot.load()).toBe('');
  });

  it('save_profile confirma solo cuando el snapshot escribió de verdad', async () => {
    const snapshot = new MemorySnapshot({ dir });
    const tool = createMemoryTool(store, () => 'telegram:main:1', snapshot);
    const saved = await tool.execute('e3', { action: 'save_profile', text: 'se llama Ana' });
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toContain('Guardado en tu perfil');
    expect(snapshot.load()).toBe('se llama Ana');
  });

  it('remember rechaza secretos y no los deja en la memoria', async () => {
    const snapshot = new MemorySnapshot({ dir });
    const tool = createMemoryTool(store, () => 'telegram:main:1', snapshot);
    const rejected = await tool.execute('e4', { action: 'remember', text: 'password: x' });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toContain('No lo he guardado');
    expect(textOf(rejected)).not.toContain('Recordado');
    expect(store.all('telegram:main:1')).toHaveLength(0);
    const refusedCard = await tool.execute('e5', {
      action: 'remember',
      text: 'mi tarjeta es 4111 1111 1111 1111',
    });
    expect(refusedCard.isError).toBe(true);
    expect(textOf(refusedCard)).toContain('No lo he guardado');
    expect(store.all('telegram:main:1')).toHaveLength(0);
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

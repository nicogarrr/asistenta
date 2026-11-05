import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IMPORT_HEADER,
  importTextFromFile,
  isImportFile,
  isImportPaste,
  planImport,
} from '../src/memory/importar.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

/**
 * /memoria importar solo leía lo pegado en el chat: el .txt que da ChatGPT o un export en
 * .json mandado como archivo no se leía. Ahora el archivo vale igual que lo pegado.
 */
describe('/memoria importar con un archivo', () => {
  it('qué archivos lee', () => {
    expect(isImportFile('memoria.txt')).toBe(true);
    expect(isImportFile('memoria.JSON')).toBe(true);
    expect(isImportFile('notas.md')).toBe(true);
    expect(isImportFile(undefined, 'text/plain')).toBe(true);
    expect(isImportFile('foto.jpg', 'image/jpeg')).toBe(false);
    expect(isImportFile('informe.pdf', 'application/pdf')).toBe(false);
  });

  it('un .txt con la respuesta de ChatGPT (con BOM y saltos de Windows) se lee como lo pegado', () => {
    const got = importTextFromFile(
      'chatgpt.txt',
      'text/plain',
      enc(`\uFEFF${IMPORT_HEADER}\r\n- Vivo en Gijón\r\n- Mi hermana se llama Laura\r\n`),
    );
    expect('text' in got && isImportPaste(got.text)).toBe(true);
    const plan = planImport((got as { text: string }).text, []);
    expect(plan.nuevos).toEqual(['Vivo en Gijón', 'Mi hermana se llama Laura']);
  });

  it.each([
    ['lista de textos', ['Vivo en Gijón', 'Soy del Sporting']],
    ['objetos con content', [{ content: 'Vivo en Gijón' }, { content: 'Soy del Sporting', id: 2 }]],
    ['{"memories": [...]}', { memories: [{ text: 'Vivo en Gijón' }, 'Soy del Sporting'] }],
  ])('un .json: %s', (_name, data) => {
    const got = importTextFromFile('export.json', 'application/json', enc(JSON.stringify(data)));
    expect('text' in got).toBe(true);
    const text = (got as { text: string }).text;
    expect(isImportPaste(text)).toBe(true);
    expect(planImport(text, []).nuevos).toEqual(['Vivo en Gijón', 'Soy del Sporting']);
  });

  it('el historial entero de ChatGPT (conversations.json) no es su memoria: lo dice', () => {
    const got = importTextFromFile(
      'conversations.json',
      'application/json',
      enc(JSON.stringify([{ title: 'x', mapping: {} }])),
    );
    expect('error' in got && got.error).toContain('historial entero');
  });

  it('JSON roto, vacío o enorme: un error claro', () => {
    expect('error' in importTextFromFile('a.json', undefined, enc('{roto'))).toBe(true);
    expect('error' in importTextFromFile('a.txt', undefined, enc('   '))).toBe(true);
    expect('error' in importTextFromFile('a.txt', undefined, new Uint8Array(1_000_001))).toBe(true);
    expect('error' in importTextFromFile('a.json', undefined, enc('{"x": 1}'))).toBe(true);
  });

  it('el daemon lee el archivo: con «/memoria importar» de pie, o solo si empieza por la cabecera', () => {
    expect(cli).toMatch(/const importFromDocument = async \(inbound: Inbound, quiet: boolean\)/);
    expect(cli).toMatch(
      /if \(inbound\.documentFileId\) \{\s*if \(await importFromDocument\(inbound, false\)\) return;/,
    );
    expect(cli).toMatch(/inbound\.documentFileId && \(await importFromDocument\(inbound, true\)\)/);
  });
});

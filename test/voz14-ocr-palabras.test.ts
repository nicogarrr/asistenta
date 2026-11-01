import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createOcrEspera, OCR_SIN_ARCHIVO, ocrWordsMode } from '../src/ocrdoc/palabras.js';

const pdf = (text: string) => ({
  text,
  documentFileId: 'f1',
  documentMimeType: 'application/pdf',
  documentName: 'contrato.pdf',
});
const foto = (text: string) => ({ text, photoFileId: 'p1' });

describe('«/ocr» sin archivo habla como un amigo', () => {
  it('no manda a escribir comandos', () => {
    expect(OCR_SIN_ARCHIVO).not.toMatch(/\/ocr/);
    expect(OCR_SIN_ARCHIVO).toContain('pásamelo a texto');
    expect(OCR_SIN_ARCHIVO).toMatch(/buscable/);
  });

  it('cli.ts ya no enseña «/ocr md» ni «/ocr todo» y deja el chat esperando el archivo', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).not.toContain('(también «/ocr md» o «/ocr todo»)');
    expect(cli).toMatch(/ocrEspera\.arm\(inbound\.chatId\);\s*await say\(inbound, OCR_SIN_ARCHIVO/);
  });
});

describe('frases con el archivo', () => {
  it.each([
    ['hazlo buscable', 'pdf'],
    ['Hazme este PDF buscable', 'pdf'],
    ['que se pueda buscar', 'pdf'],
    ['ponlo seleccionable', 'pdf'],
    ['hazlo buscable y pásamelo a texto', 'todo'],
  ])('PDF + «%s» → %s', (text, mode) => {
    expect(ocrWordsMode(pdf(text), false)).toBe(mode);
  });

  it('una foto con «hazlo buscable» también', () => {
    expect(ocrWordsMode(foto('hazlo buscable'), false)).toBe('pdf');
    expect(
      ocrWordsMode(
        { text: 'hazlo buscable', documentFileId: 'd', documentMimeType: 'image/jpeg' },
        false,
      ),
    ).toBe('pdf');
  });

  it.each([
    '',
    'resume este PDF',
    'pásamelo a texto',
    'todo',
    '/ocr',
    'no lo hagas buscable',
    'hazlo buscable y luego mándaselo a mi gestor con un resumen de las tres cláusulas',
  ])('sin haberlo pedido, «%s» sigue la conversación normal', (text) => {
    expect(ocrWordsMode(pdf(text), false)).toBeNull();
    expect(ocrWordsMode(foto(text), false)).toBeNull();
  });

  it('sin archivo nunca es OCR', () => {
    expect(ocrWordsMode({ text: 'hazlo buscable' }, true)).toBeNull();
    expect(ocrWordsMode({ text: '', documentFileId: 'x', documentName: 'a.zip' }, true)).toBeNull();
  });
});

describe('el archivo que llega después de «/ocr» sin archivo', () => {
  it.each([
    ['', 'pdf'],
    ['pásamelo a texto', 'md'],
    ['solo el texto', 'md'],
    ['las dos cosas', 'todo'],
    ['hazlo buscable', 'pdf'],
  ])('«%s» → %s', (text, mode) => {
    expect(ocrWordsMode(pdf(text), true)).toBe(mode);
    expect(ocrWordsMode(foto(text), true)).toBe(mode);
  });

  it('otra petición con el archivo la sigue leyendo el modelo', () => {
    expect(ocrWordsMode(foto('¿qué pone aquí?'), true)).toBeNull();
  });

  it('la espera dura unos minutos y es por chat', () => {
    let t = 0;
    const e = createOcrEspera(10 * 60_000, () => t);
    expect(e.isArmed(5)).toBe(false);
    e.arm(5);
    expect(e.isArmed('5')).toBe(true);
    expect(e.isArmed(6)).toBe(false);
    t = 10 * 60_000 + 1;
    expect(e.isArmed(5)).toBe(false);
    e.arm(5);
    e.clear(5);
    expect(e.isArmed(5)).toBe(false);
  });

  it('el enganche va antes del turno del modelo y solo en el chat del dueño', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    const control = cli.indexOf("if (control === 'handled') return;");
    const hook = cli.indexOf('const ocrMode = ocrByWords(inbound);', control);
    const turn = cli.indexOf('const thread = await resolveThread(inbound);', control);
    expect(hook).toBeGreaterThan(control);
    expect(hook).toBeLessThan(turn);
    expect(cli).toMatch(/const ocrByWords = [\s\S]{0,200}isOwnerDm\(inbound, vigilanteOwnerId\)/);
  });
});

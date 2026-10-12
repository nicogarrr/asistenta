import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DocMemory } from '../src/memory/docs.js';
import {
  imageExtension,
  imageNote,
  MAX_IMAGE_BYTES,
  MAX_OCR_CHARS,
  ocrImageBytes,
} from '../src/memory/images.js';
import type { OcrResult } from '../src/screen/ocr.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'mi-test-'));
  dirs.push(d);
  return d;
};
const opened: Array<{ close: () => void }> = [];
afterEach(() => {
  // En Windows un DocMemory abierto mantiene el .sqlite bloqueado y el rmSync
  // falla con EBUSY. Los tests que crean la memoria y no la cierran dependen de
  // este arnes para liberarla antes de borrar el temporal.
  while (opened.length) {
    try {
      opened.pop()?.close();
    } catch {
      // Una memoria ya cerrada no debe impedir borrar el temporal.
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const ocrOf = (...texts: string[]): OcrResult => ({
  lines: texts.map((text, i) => ({ text, x: 0, y: i, width: 1, height: 1, words: [] })),
  text: texts.join('\n'),
  language: 'es-ES',
  width: 10,
  height: 10,
});
const mem = (): DocMemory => {
  const d = tmp();
  const memory = new DocMemory({ dbPath: join(d, 'd.sqlite'), directory: join(d, 'txt') });
  opened.push(memory);
  return memory;
};

describe('OCR de imágenes', () => {
  const jpg = Buffer.from('fake-jpeg-bytes');
  it('lee el texto, borra la copia temporal y no deja nada en disco', async () => {
    const root = tmp();
    let seen = '';
    const out = await ocrImageBytes(jpg, 'image/jpeg', {
      platform: 'win32',
      tempRoot: root,
      ocrAvailable: async () => true,
      ocrImage: async (p) => {
        seen = p;
        expect(existsSync(p)).toBe(true);
        return ocrOf('Factura 123', 'Total  45,00 €');
      },
    });
    expect(out).toEqual({ status: 'ok', text: 'Factura 123\nTotal 45,00 €', truncated: false });
    expect(seen.endsWith('.jpg')).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });
  it('si el OCR falla, también se borra y se dice', async () => {
    const root = tmp();
    const out = await ocrImageBytes(jpg, 'image/png', {
      platform: 'win32',
      tempRoot: root,
      ocrAvailable: async () => true,
      ocrImage: async () => Promise.reject(new Error('boom')),
    });
    expect(out).toEqual({ status: 'unavailable', reason: 'el OCR falló al leer la imagen' });
    expect(readdirSync(root)).toEqual([]);
  });
  it('sin texto legible: no-text', async () => {
    const out = await ocrImageBytes(jpg, 'image/jpeg', {
      platform: 'win32',
      tempRoot: tmp(),
      ocrAvailable: async () => true,
      ocrImage: async () => ocrOf('  ', ''),
    });
    expect(out).toEqual({ status: 'no-text' });
  });
  it.each([
    ['linux', 'image/jpeg', 'solo funciona en Windows'],
    ['win32', 'image/webp', 'JPG, PNG, BMP, GIF y TIFF'],
    ['win32', undefined, 'tipo desconocido'],
  ])('no disponible (%s, %s)', async (platform, mime, frag) => {
    let called = 0;
    const out = await ocrImageBytes(jpg, mime, {
      platform: platform as NodeJS.Platform,
      tempRoot: tmp(),
      ocrAvailable: async () => true,
      ocrImage: async () => {
        called++;
        return ocrOf('x');
      },
    });
    expect(out.status).toBe('unavailable');
    expect((out as { reason: string }).reason).toContain(frag);
    expect(called).toBe(0);
  });
  it('vacía, enorme o sin idioma de OCR', async () => {
    const base = { platform: 'win32' as const, tempRoot: tmp(), ocrImage: async () => ocrOf('x') };
    expect(
      await ocrImageBytes(Buffer.alloc(0), 'image/jpeg', {
        ...base,
        ocrAvailable: async () => true,
      }),
    ).toMatchObject({ status: 'unavailable' });
    expect(
      await ocrImageBytes(Buffer.alloc(MAX_IMAGE_BYTES + 1), 'image/jpeg', {
        ...base,
        ocrAvailable: async () => true,
      }),
    ).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('20 MB') });
    expect(
      await ocrImageBytes(jpg, 'image/jpeg', { ...base, ocrAvailable: async () => false }),
    ).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('idioma de OCR') });
  });
  it('texto enorme se recorta y se declara', async () => {
    const out = await ocrImageBytes(jpg, 'image/jpeg', {
      platform: 'win32',
      tempRoot: tmp(),
      ocrAvailable: async () => true,
      ocrImage: async () => ocrOf('a'.repeat(MAX_OCR_CHARS + 500)),
    });
    expect(out).toMatchObject({ status: 'ok', truncated: true });
    expect((out as { text: string }).text).toHaveLength(MAX_OCR_CHARS);
  });
  it('extensiones soportadas', () => {
    expect(imageExtension('IMAGE/JPEG')).toBe('jpg');
    expect(imageExtension('image/svg+xml')).toBeNull();
  });
});

describe('indexOcr: foto -> memoria documental', () => {
  it('se encuentra por el texto de la foto, con tipo image/ocr y título de la leyenda', () => {
    const m = mem();
    const r = m.indexOcr(
      'chat:A',
      'file123456789',
      'Contrato de alquiler. Fianza 1200 euros',
      'el piso',
    );
    expect(r).toMatchObject({ mimeType: 'image/ocr', title: 'foto: el piso', truncated: false });
    const hits = m.search('chat:A', 'fianza');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe('foto: el piso');
    expect(hits[0]?.snippet).toContain('«Fianza»');
    expect(m.list('chat:A')[0]).toMatchObject({ mimeType: 'image/ocr' });
  });
  it('aislamiento por hilo: otro chat no ve la foto, ni por búsqueda ni por lista', () => {
    const m = mem();
    m.indexOcr('chat:A', 'f1', 'canario-secreto-alfa', 'x');
    expect(m.search('chat:B', 'canario-secreto-alfa')).toEqual([]);
    expect(m.list('chat:B')).toEqual([]);
    // misma foto reenviada a otro chat: dos filas, y borrar/reindexar una no toca la otra
    m.indexOcr('chat:B', 'f1', 'canario-secreto-beta', 'x');
    expect(m.search('chat:A', 'canario-secreto-alfa')).toHaveLength(1);
    expect(m.search('chat:A', 'canario-secreto-beta')).toEqual([]);
    m.indexOcr('chat:B', 'f1', 'otro texto distinto', 'x');
    expect(m.search('chat:A', 'canario-secreto-alfa')).toHaveLength(1);
  });
  it('reindexar la misma foto en el mismo hilo la sustituye', () => {
    const m = mem();
    m.indexOcr('chat:A', 'f1', 'texto viejo unico', undefined);
    m.indexOcr('chat:A', 'f1', 'texto nuevo unico', undefined);
    expect(m.search('chat:A', 'viejo')).toEqual([]);
    expect(m.search('chat:A', 'nuevo')).toHaveLength(1);
    expect(m.list('chat:A')).toHaveLength(1);
  });
  it('sin texto: null; muy largo: parcial', () => {
    const m = mem();
    expect(m.indexOcr('chat:A', 'f1', '   \n  ')).toBeNull();
    const big = Array.from({ length: 2500 }, (_, i) => `linea ${i} ${'palabra '.repeat(40)}`).join(
      '\n\n',
    );
    const r = m.indexOcr('chat:A', 'f2', big);
    expect(r?.truncated).toBe(true);
  });
});

describe('notas para el modelo (honestas)', () => {
  it('cada resultado dice lo que pasó y sus límites', () => {
    expect(
      imageNote(
        'Foto',
        { status: 'unavailable', reason: 'el OCR de fotos solo funciona en Windows' },
        null,
      ),
    ).toBe('[Foto: no se indexó: el OCR de fotos solo funciona en Windows.]');
    expect(imageNote('Foto', { status: 'no-text' }, null)).toContain('no tenía texto legible');
    const ok = imageNote(
      'Foto',
      { status: 'ok', text: 'x', truncated: false },
      { chars: 12, truncated: false },
    );
    expect(ok).toContain('indexado en la memoria documental (12 caracteres)');
    expect(ok).toContain('puede equivocarse');
    expect(ok).toContain('solo cubre el texto visible');
    expect(
      imageNote(
        'Foto',
        { status: 'ok', text: 'x', truncated: true },
        { chars: 12, truncated: false },
      ),
    ).toContain('PARCIALMENTE');
  });
});

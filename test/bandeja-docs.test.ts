import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectCapture } from '../src/bandeja/captura.js';
import { buildEpub, deliverToKindle, kindleable } from '../src/bandeja/kindle.js';
import { BandejaQueue, type ProcesarDeps, processItem } from '../src/bandeja/procesar.js';
import { type BandejaItem, BandejaStore } from '../src/bandeja/store.js';
import { extractText as extractDocText } from '../src/memory/docs.js';

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');
const REPLY =
  'TITULO: T\nVEREDICTO: IMPRESCINDIBLE\nNOTA: 8\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';
const LIBRO = Array.from(
  { length: 40 },
  (_, i) =>
    `Capítulo ${i + 1}. La acción humana es conducta consciente y deliberada, y de ella parte toda la teoría económica que aquí se expone con detalle.`,
);

let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kindle-docs-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function epubBytes(): Buffer {
  return buildEpub(
    { title: 'La acción humana', author: 'Mises', blocks: LIBRO.map((text) => ({ t: 'p', text })) },
    NOV11,
  );
}

function addDoc(fileName: string, mimeType: string): BandejaItem {
  const cands = detectCapture({
    text: '',
    documentFileId: 'DOC1',
    documentMimeType: mimeType,
    documentName: fileName,
  });
  expect(cands).toHaveLength(1);
  return store.add(CHAT, cands?.[0] as never, NOV11, '2026-11-11').item;
}

function procDeps(bytes: Buffer): ProcesarDeps {
  return {
    complete: async () => async () => REPLY,
    fetchRaw: async () => '',
    videoText: async () => ({ ok: false, reason: 'no' }),
    download: async () => bytes,
    docText: (b, mime, name) => extractDocText(b, mime, undefined, undefined, name),
  };
}

describe('bandeja: EPUB y DOCX que mandas', () => {
  it('un EPUB a secas se lee entero y se juzga (antes: «solo PDF»)', async () => {
    const item = addDoc('La_accion_humana.epub', 'application/epub+zip');
    const r = await processItem(item, procDeps(epubBytes()));
    expect(r.verdict).toBe('imprescindible');
    expect(r.title).toBe('La accion humana');
    expect(r.costLabel).toMatch(/^📘 ~\d+ págs · ~\d+ min$/);
    expect(r.extra).toMatchObject({ source: 'EPUB', basis: 'texto' });
    expect(r.body).toContain('Capítulo 40.');
  });

  it('un EPUB va al Kindle tal cual (y su AZW3 con Calibre), sin rehacerlo', async () => {
    const bytes = epubBytes();
    const item = addDoc('La_accion_humana.epub', 'application/octet-stream');
    await new BandejaQueue(store, procDeps(bytes)).enqueue(item.id);
    const fresh = store.get(item.id) as BandejaItem;
    expect(kindleable(fresh)).toBe(true);
    const sent: Array<{ name: string; bytes: Buffer }> = [];
    const convert = vi.fn(async () => ({ ok: true as const, azw3: Buffer.from('AZW3') }));
    const text = await deliverToKindle(
      { item: fresh },
      {
        store,
        chatId: CHAT,
        fetchRaw: async () => '',
        download: async () => bytes,
        convert,
        sendFile: async (b, name) => {
          sent.push({ name, bytes: b });
        },
        env: {},
        now: () => NOV11,
      },
    );
    expect(sent.map((f) => f.name)).toEqual(['La_accion_humana.azw3', 'La_accion_humana.epub']);
    expect(sent[1]?.bytes).toBe(bytes);
    expect(convert).toHaveBeenCalledWith(bytes, 'La_accion_humana');
    expect(text).toContain('el EPUB original tal cual');
  });

  it('un DOCX: su texto entero va al Kindle en EPUB', async () => {
    const item = addDoc(
      'informe.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const docText = vi.fn(async () => LIBRO.join('\n'));
    await new BandejaQueue(store, { ...procDeps(Buffer.from('docx')), docText }).enqueue(item.id);
    const fresh = store.get(item.id) as BandejaItem;
    expect(fresh.verdict).toBe('imprescindible');
    expect(kindleable(fresh)).toBe(true);
    const sent: string[] = [];
    await deliverToKindle(
      { item: fresh },
      {
        store,
        chatId: CHAT,
        fetchRaw: async () => '',
        convert: async () => ({ ok: false, reason: 'no-converter', message: 'x' }),
        sendFile: async (_b, name) => {
          sent.push(name);
        },
        env: {},
        now: () => NOV11,
      },
    );
    expect(sent).toEqual(['informe.epub']);
  });

  it('un documento que no sé leer lo dice con lo que sí leo', async () => {
    const item = addDoc('cosas.zip', 'application/zip');
    expect(kindleable(item)).toBe(false);
    await expect(processItem(item, procDeps(Buffer.from('x')))).rejects.toThrow(
      /PDF, EPUB, DOCX u ODT sí/,
    );
  });
});

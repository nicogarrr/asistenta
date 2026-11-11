import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BandejaQueue, type ProcesarDeps } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-33 (11 nov 2026): el mismo PDF mandado dos veces (reenviado desde otro chat, o
// mandado otra vez porque no se acordaba) eran DOS cosas: dos veredictos del modelo, dos
// líneas en el resumen de la noche. Telegram da un file_id distinto en cada envío, así que
// no había con qué compararlo. Ahora se compara la huella del fichero (sha256).

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');
const REPLY =
  'TITULO: T\nVEREDICTO: IMPRESCINDIBLE\nNOTA: 8\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';
const PDF_A = Buffer.from('%PDF-1.4 tesis ASTS v3');
const PDF_B = Buffer.from('%PDF-1.4 otra cosa');
const TEXT = 'palabra '.repeat(300);

let dir: string;
let store: BandejaStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs33-dedupe-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function pdf(fileId: string, name = 'tesis.pdf') {
  return store.add(
    CHAT,
    { kind: 'pdf', fileId, fileName: name, mimeType: 'application/pdf' },
    NOV11,
    '2026-11-11',
  ).item;
}

function deps(files: Record<string, Buffer>) {
  let modelCalls = 0;
  const d: ProcesarDeps = {
    complete: async () => async () => {
      modelCalls++;
      return REPLY;
    },
    fetchRaw: async () => '',
    videoText: async () => ({ ok: false, reason: 'no' }) as never,
    download: async (id) => files[id] ?? null,
    pdfText: async () => TEXT,
  };
  return { d, models: () => modelCalls };
}

describe('bandeja: el mismo fichero dos veces es una sola cosa', () => {
  it('el segundo envío del mismo PDF (otro file_id) se cierra como repetido sin gastar modelo', async () => {
    const { d, models } = deps({ f1: PDF_A, f2: Buffer.from(PDF_A) });
    const queue = new BandejaQueue(store, d);
    const a = pdf('f1');
    const b = pdf('f2', 'tesis (1).pdf');
    void queue.enqueue(a.id);
    void queue.enqueue(b.id);
    await queue.idle();
    expect(store.get(a.id)).toMatchObject({ status: 'listo', verdict: 'imprescindible' });
    expect(store.get(b.id)?.state).toBe('descartado');
    expect(store.get(b.id)?.error ?? store.get(b.id)?.reason ?? '').toMatch(`#${a.id}`);
    expect(models()).toBe(1);
  });

  it('dos PDFs distintos siguen siendo dos cosas', async () => {
    const { d, models } = deps({ f1: PDF_A, f2: PDF_B });
    const queue = new BandejaQueue(store, d);
    const a = pdf('f1');
    const b = pdf('f2', 'otra.pdf');
    void queue.enqueue(a.id);
    void queue.enqueue(b.id);
    await queue.idle();
    expect(store.get(a.id)?.status).toBe('listo');
    expect(store.get(b.id)?.status).toBe('listo');
    expect(models()).toBe(2);
  });

  it('si el primero ya se vio o se descartó, volver a mandarlo sí cuenta (lo quiere otra vez)', async () => {
    const { d, models } = deps({ f1: PDF_A, f2: Buffer.from(PDF_A) });
    const queue = new BandejaQueue(store, d);
    const a = pdf('f1');
    await queue.enqueue(a.id);
    store.setState(a.id, 'visto');
    const b = pdf('f2');
    await queue.enqueue(b.id);
    expect(store.get(b.id)?.status).toBe('listo');
    expect(models()).toBe(2);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectCapture } from '../src/bandeja/captura.js';
import { captureAndAck } from '../src/bandeja/comando.js';
import type { BandejaQueue } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-32 (11 nov 2026): varias capturas (o varios PDFs) enviados de una vez llegan como un
// álbum: un solo mensaje con `albumPhotoFileIds` / `albumDocuments`. La bandeja solo miraba
// la primera foto o el primer documento: de 3 capturas guardaba 1, sin decir nada.

describe('bandeja: álbumes', () => {
  it('3 capturas de una vez = 3 cosas', () => {
    const got = detectCapture({ text: '', photoFileId: 'P1', albumPhotoFileIds: ['P2', 'P3'] });
    expect(got?.map((c) => [c.kind, c.fileId])).toEqual([
      ['imagen', 'P1'],
      ['imagen', 'P2'],
      ['imagen', 'P3'],
    ]);
  });

  it('2 PDFs y un EPUB de una vez = 3 cosas, cada una con su nombre y tipo', () => {
    const got = detectCapture({
      text: '',
      documentFileId: 'D1',
      documentMimeType: 'application/pdf',
      documentName: 'tesis-v3.pdf',
      albumDocuments: [
        { fileId: 'D2', mimeType: 'application/pdf', name: 'q3.pdf' },
        { fileId: 'D3', mimeType: 'application/epub+zip', name: 'mises.epub' },
      ],
    });
    expect(got?.map((c) => [c.kind, c.fileId, c.fileName])).toEqual([
      ['pdf', 'D1', 'tesis-v3.pdf'],
      ['pdf', 'D2', 'q3.pdf'],
      ['texto', 'D3', 'mises.epub'],
    ]);
  });

  it('un álbum con tu pregunta sigue siendo conversación', () => {
    expect(
      detectCapture({ text: '¿cuál es mejor?', photoFileId: 'P1', albumPhotoFileIds: ['P2'] }),
    ).toBeNull();
  });

  describe('guardado', () => {
    let dir: string;
    let store: BandejaStore;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'bugs32-album-'));
      store = new BandejaStore(join(dir, 'bandeja.db'));
    });
    afterEach(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('el aviso dice las 3 y las 3 quedan en la bandeja', () => {
      const queued: number[] = [];
      const cands = detectCapture({
        text: '',
        photoFileId: 'P1',
        albumPhotoFileIds: ['P2', 'P3'],
      });
      const reply = captureAndAck(
        {
          store,
          queue: { enqueue: async (id: number) => void queued.push(id) } as unknown as BandejaQueue,
          chatId: '111',
          now: () => new Date('2026-11-11T09:00:00Z'),
        },
        cands ?? [],
      );
      expect(reply.text).toContain('3 cosas guardadas');
      expect(store.ofDay('111', '2026-11-11')).toHaveLength(3);
      expect(queued).toHaveLength(3);
    });
  });
});

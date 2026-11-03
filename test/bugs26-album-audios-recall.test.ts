import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keepAlbumTranscripts } from '../src/cli.js';
import { AudioRecall } from '../src/media/recall.js';

/**
 * Varios audios enviados juntos: solo el primero quedaba con lo que dijo en la lista de
 * audios recientes, así que «suéltame el que hablaba de la reunión» no podía elegir entre
 * los demás. Y los otros se indexaban con el file_id de Telegram en vez de su message_id
 * (título «audio AwACAgQAAx…»). Ahora cada uno queda con lo suyo y su message_id.
 */
describe('álbum de audios: lo oído de cada audio queda con el suyo', () => {
  it('el recall y la memoria reciben lo de cada audio por su message_id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alb26-'));
    try {
      const recall = new AudioRecall({ directory: dir });
      for (const [fileId, messageId] of [
        ['F1', '11'],
        ['F2', '12'],
        ['F3', '13'],
      ] as const) {
        recall.record('tg:1', { fileId, mimeType: 'audio/ogg', messageId });
      }
      recall.setTranscript('tg:1', '11', 'compra pan');
      const indexed: string[] = [];
      const warned: unknown[] = [];
      keepAlbumTranscripts(
        [
          { audio: { fileId: 'F2', messageId: '12' }, heard: { text: 'la reunión es a las 5' } },
          { audio: { fileId: 'F3', messageId: '13' }, failed: 'download' },
          { audio: { fileId: 'F4' }, heard: { text: 'sin id' } },
        ],
        {
          recall: (messageId, text) => recall.setTranscript('tg:1', messageId, text),
          index: (id, text) => {
            indexed.push(`${id}: ${text}`);
            if (id === 'F4') throw new Error('disco lleno');
          },
          warn: (err) => warned.push(err),
        },
      );
      expect(recall.byMessage('tg:1', '12')?.transcript).toBe('la reunión es a las 5');
      expect(recall.byMessage('tg:1', '11')?.transcript).toBe('compra pan');
      expect(recall.byMessage('tg:1', '13')?.transcript).toBeUndefined();
      expect(indexed).toEqual(['12: la reunión es a las 5', 'F4: sin id']);
      // Un fallo al indexar no tumba el resto.
      expect(warned).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

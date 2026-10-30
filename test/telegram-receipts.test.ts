import { describe, expect, it } from 'vitest';
import {
  InboundReceipt,
  RECEIPT_READ_TEXT,
  receiptKind,
  receiptStartText,
  voiceHeardText,
} from '../src/channels/telegram-receipts.js';

function fakeChat(opts: { sendFails?: boolean; editFails?: boolean } = {}) {
  const log: string[] = [];
  return {
    log,
    deps: {
      send: async (text: string) => {
        if (opts.sendFails) throw new Error('429');
        log.push(`send:${text}`);
        return '55';
      },
      edit: async (id: string, text: string) => {
        if (opts.editFails) throw new Error('400');
        log.push(`edit:${id}:${text}`);
      },
    },
  };
}

describe('acuse de recibo de voz, foto y documento', () => {
  it('elige el acuse por lo que llega', () => {
    expect(receiptKind({ audioFileId: 'a' })).toBe('voice');
    expect(receiptKind({ photoFileId: 'p' })).toBe('photo');
    expect(receiptKind({ documentFileId: 'd', documentMimeType: 'audio/mpeg' })).toBe('audio');
    expect(receiptKind({ documentFileId: 'd', documentMimeType: 'image/png' })).toBe('photo');
    expect(receiptKind({ documentFileId: 'd', documentMimeType: 'application/pdf' })).toBe(
      'document',
    );
    expect(receiptKind({})).toBeNull();
  });

  it('textos en español, con el nombre del fichero sin ruta y con tope', () => {
    expect(receiptStartText('voice')).toBe('🎙️ Transcribiendo la nota de voz…');
    expect(receiptStartText('document', { documentName: 'C:\\x\\factura.pdf' })).toBe(
      '📄 Leyendo «factura.pdf»…',
    );
    expect(receiptStartText('document')).toBe('📄 Leyendo el documento…');
    const long = receiptStartText('audio', { documentName: `${'a'.repeat(100)}.mp3` });
    expect(long.length).toBeLessThan(80);
  });

  it('la nota de voz queda editada con lo que se entendió, recortado', async () => {
    const chat = fakeChat();
    const r = new InboundReceipt(chat.deps);
    await r.start(receiptStartText('voice'));
    await r.update(voiceHeardText('  compra   leche\nmañana '));
    expect(chat.log).toEqual([
      'send:🎙️ Transcribiendo la nota de voz…',
      'edit:55:🎙️ «compra leche mañana»',
    ]);
    expect(voiceHeardText('x'.repeat(1000)).length).toBeLessThan(320);
    expect(voiceHeardText('   ')).toMatch(/No he entendido/);
  });

  it('no repite una edición idéntica ni edita sin acuse publicado', async () => {
    const chat = fakeChat();
    const r = new InboundReceipt(chat.deps);
    await r.update(RECEIPT_READ_TEXT); // sin start: nada
    await r.start('📄 Leyendo el documento…');
    await r.update(RECEIPT_READ_TEXT);
    await r.update(RECEIPT_READ_TEXT);
    expect(chat.log).toHaveLength(2);
    expect(r.id).toBe('55');
  });

  it('un fallo de Telegram nunca rompe el turno', async () => {
    const down = new InboundReceipt(fakeChat({ sendFails: true }).deps);
    await expect(down.start('🖼️ Mirando la foto…')).resolves.toBeUndefined();
    expect(down.id).toBeNull();
    const noEdit = new InboundReceipt(fakeChat({ editFails: true }).deps);
    await noEdit.start('x');
    await expect(noEdit.update('y')).resolves.toBeUndefined();
  });
});

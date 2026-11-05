import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  InboundReceipt,
  receiptKind,
  receiptStartsFor,
  voiceHeardText,
} from '../src/channels/telegram-receipts.js';

describe('audio sin eco de la transcripción', () => {
  it('una nota de voz no lleva acuse «transcribiendo»; foto, documento y audio-archivo sí', () => {
    expect(receiptStartsFor('voice')).toBe(false);
    expect(receiptStartsFor('photo')).toBe(true);
    expect(receiptStartsFor('document')).toBe(true);
    expect(receiptStartsFor('audio')).toBe(true);
    expect(receiptKind({ audioFileId: 'a' })).toBe('voice');
  });

  it('sin acuse iniciado, lo entendido no se publica; solo «no entendí nada» sí', async () => {
    const enviados: string[] = [];
    const receipt = new InboundReceipt({
      send: async (t) => {
        enviados.push(t);
        return 'm1';
      },
      edit: async (_id, t) => {
        enviados.push(t);
      },
    });
    // Como en cli.ts: no se hace start() para voz; al entender, update() no publica nada.
    await receipt.update(voiceHeardText('compra leche mañana'));
    expect(enviados).toEqual([]);
    await receipt.show(voiceHeardText(''));
    expect(enviados).toEqual(['🎙️ No he entendido ninguna palabra.']);
  });

  it('cli.ts solo arranca el acuse cuando receiptStartsFor lo permite', () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).toMatch(/if \(kind && receiptStartsFor\(kind\) &&/);
    expect(src).toContain(
      "if (!heard.text.trim()) await receipt.show(voiceHeardText('', inbound.audioIsVideo));",
    );
  });
});

import { describe, expect, it } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram.js';
import { pricewatchMuteReply, vigilaSilenceReply } from '../src/cli.js';

describe('tras «avisar otra vez» se puede volver a silenciar con un toque', () => {
  it('/vigila avisar <id> ofrece «🔕 Silenciar 1 día» (= /vigila silenciar <id>)', () => {
    const r = vigilaSilenceReply('avisar', {
      id: 'abc123',
      label: 'Tele 55',
      url: 'https://example.com/tele',
      mutedUntil: 0,
    });
    expect(r.text).toBe('🔔 Vuelvo a avisarte de Tele 55.');
    expect(r.buttons.map((b) => b.label)).toEqual(['🔕 Silenciar 1 día']);
    expect(commandFromCallback(r.buttons[0]?.action ?? '')).toBe('/vigila silenciar abc123');
  });

  it('/precio avisar <clave> ofrece «🔕 Silenciar 1 día» (= /precio silenciar <clave>)', () => {
    const r = pricewatchMuteReply('avisar', 'a1b2c3d4', { product: 'TV', until: 0 });
    expect(r.text).toBe('🔔 Vuelvo a avisarte de TV.');
    expect(r.buttons.map((b) => b.label)).toEqual(['🔕 Silenciar 1 día']);
    expect(commandFromCallback(r.buttons[0]?.action ?? '')).toBe('/precio silenciar a1b2c3d4');
  });

  it('si no había nada que reactivar, sin botón', () => {
    expect(pricewatchMuteReply('avisar', 'a1b2c3d4', null).buttons).toEqual([]);
    expect(vigilaSilenceReply('avisar', null).buttons).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram.js';
import { vigilaSilenceReply } from '../src/cli.js';

const w = {
  id: 'abc123',
  label: 'Tele 55',
  url: 'https://www.mediamarkt.es/es/product/_tele-123.html',
  mutedUntil: Date.UTC(2026, 9, 31, 19, 0),
};

describe('«🔔 Avisar otra vez» tras silenciar', () => {
  it('la respuesta de silenciar lleva el botón, que equivale a /vigila avisar <id>', () => {
    const r = vigilaSilenceReply('silenciar', w);
    expect(r.text).toContain('🔕 Silenciada 1 día: Tele 55');
    expect(r.text).toContain('/vigila avisar abc123');
    expect(r.buttons).toHaveLength(1);
    expect(r.buttons[0]?.label).toBe('🔔 Avisar otra vez');
    expect(commandFromCallback(r.buttons[0]?.action ?? '')).toBe('/vigila avisar abc123');
  });

  it('«no encuentro» no lleva botón', () => {
    const none = vigilaSilenceReply('silenciar', null);
    expect(none.text).toContain('No encuentro esa vigilancia');
    expect(none.buttons).toEqual([]);
  });

  it('sin nombre usa el enlace', () => {
    expect(vigilaSilenceReply('avisar', { ...w, label: '' }).text).toContain(w.url);
  });
});

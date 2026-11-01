import { describe, expect, it } from 'vitest';
import { closedLine } from '../src/daemon/close-loop.js';
import { panelFileName } from '../src/daemon/panel-chat.js';
import { parcelCheckInLine } from '../src/daemon/parcel-checkin.js';
import { summarizeTranscript } from '../src/daemon/transcript-summary.js';
import type { Delivery } from '../src/mail/deliveries.js';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Texto con un emoji exactamente en el punto de corte `cut`. */
const withEmojiAt = (cut: number) => `${'a'.repeat(cut - 1)}🎉${'b'.repeat(50)}`;

describe('cortes sin medio emoji, segunda ola (bugs12)', () => {
  it('parcelCheckInLine: el nombre del paquete no enseña medio emoji', () => {
    const d: Delivery = {
      key: 'k1',
      carrier: 'tienda',
      tracking: null,
      orderRef: null,
      title: `Pedido ${'a'.repeat(51)}🎉${'b'.repeat(50)}`,
      status: 'en_reparto',
      statusAt: Date.now(),
      notified: null,
    };
    const line = parcelCheckInLine(d);
    expect(loneSurrogate.test(line)).toBe(false);
    expect(line).toContain('…');
  });

  it('closedLine: el asunto recortado no enseña medio emoji', () => {
    const line = closedLine(withEmojiAt(79));
    expect(loneSurrogate.test(line)).toBe(false);
    expect(line).toContain('…');
  });

  it('panelFileName: el nombre de descarga no queda con medio emoji', () => {
    const name = panelFileName(withEmojiAt(120));
    expect(loneSurrogate.test(name)).toBe(false);
    expect([...name].length).toBeLessThanOrEqual(120);
  });

  it('summarizeTranscript: los turnos recortados no llevan medio emoji', () => {
    const summary = summarizeTranscript([
      { role: 'user', content: withEmojiAt(300) },
      { role: 'assistant', content: withEmojiAt(300) },
    ]);
    expect(loneSurrogate.test(summary)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { MailMessage } from '../src/mail/types.js';
import { parseCharge, scanMoney } from '../src/ojo-charges.js';

const mail = (text: string): MailMessage =>
  ({
    id: 'm1',
    from: 'Tienda <pagos@tienda.es>',
    subject: 'Cargo en tu tarjeta',
    text,
  }) as unknown as MailMessage;

describe('ojo-charges: miles con espacio tipográfico (mismo criterio que #451)', () => {
  for (const sep of ['\u00a0', '\u202f', '\u2009']) {
    const cp = sep.codePointAt(0)?.toString(16);
    it(`«1${cp}299,00 €» son 1299 €, no se ignora el cargo`, () => {
      expect(scanMoney(`Cargo de 1${sep}299,00 € en tu tarjeta`)).toEqual({
        cents: [129_900],
        bad: false,
      });
      expect(parseCharge(mail(`Te hemos cobrado 1${sep}299,00${sep}€`))?.cents).toBe(129_900);
    });
    it(`«EUR 12${cp}345» con la divisa delante`, () => {
      expect(scanMoney(`Importe: EUR 12${sep}345,50`).cents).toEqual([1_234_550]);
    });
  }

  it('un espacio normal sigue sin leerse (ambiguo): nunca se infiere 299 €', () => {
    const r = scanMoney('Cargo de 1 299,00 € hoy');
    expect(r.cents).not.toContain(29_900);
    expect(parseCharge(mail('Cargo de 1 299,00 € hoy'))).toBeNull();
  });

  it('grupos mal formados o separadores mezclados: ilegible, no se infiere nada', () => {
    expect(scanMoney('Cargo 1\u00a029,00 €').bad).toBe(true);
    expect(scanMoney('Cargo 1\u00a0299.000,00 €').bad).toBe(true);
    expect(scanMoney('Cargo 12345\u00a0299,00 €').bad).toBe(true);
  });

  it('los formatos de antes no cambian', () => {
    expect(scanMoney('Cargo de 1.299,00 €').cents).toEqual([129_900]);
    expect(scanMoney('Cargo de 12,50 €').cents).toEqual([1250]);
    expect(scanMoney('Cargo de -12,50 €').bad).toBe(true);
  });
});

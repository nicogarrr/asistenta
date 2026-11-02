import { describe, expect, it } from 'vitest';
import { describeSelection } from '../src/mail/cleanup.js';
import { parseDelivery } from '../src/mail/deliveries.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

// asis-bugs-18: el asunto del correo se cortaba a ciegas (80 en repartos, 50 en los
// ejemplos de la limpieza); un emoji justo en el corte quedaba partido («�»).
describe('correo: asuntos recortados sin medio emoji', () => {
  it('repartos guarda el título sin medio emoji', () => {
    const parsed = parseDelivery({
      from: 'envios@correos.es',
      subject: `${'a'.repeat(79)}📦 tu envío está en reparto`,
      text: 'Tu envío PQ12345678901234567890X está en reparto.',
    });
    expect(parsed?.title).toBe('a'.repeat(79));
    expect(parsed?.title).not.toMatch(LONE);
  });

  it('la vista previa de la limpieza no parte un emoji del asunto', () => {
    const text = describeSelection(
      [
        {
          from: 'news@tienda.example',
          subject: `${'b'.repeat(49)}🎁 ofertas`,
          category: 'promociones',
        } as never,
      ],
      'archivar',
    );
    expect(text).toContain(`«${'b'.repeat(49)}»`);
    expect(text).not.toMatch(LONE);
  });
});

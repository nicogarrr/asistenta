import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/core/capabilities.js';
import { TOOL_ABILITIES } from '../src/funciones.js';
import {
  BOTON_AMAZON,
  BOTON_APPLE_PAY,
  createPagoIphoneTool,
  enlacePagoValido,
  mensajePago,
  urlCestaAmazon,
} from '../src/tools/pago-iphone.js';

// Idea 5 del iPhone (Nico, 7 nov): Asistenta deja la cesta lista y Nico paga en Safari
// con Apple Pay. La herramienta solo manda el enlace; nunca paga.

type Enviado = { chatId: string; text: string; buttons: Array<{ label: string; action: string }> };

function tool(chat = '42') {
  const enviados: Enviado[] = [];
  const t = createPagoIphoneTool(
    {
      send: async (chatId, text, buttons) => {
        enviados.push({ chatId, text, buttons });
      },
    },
    () => chat,
  );
  const run = async (args: Record<string, unknown>) => {
    const r = await t.execute('id', args as never);
    const c = r.content[0];
    return c && c.type === 'text' ? c.text : '';
  };
  return { enviados, run };
}

describe('enlace de pago para el iPhone', () => {
  it('con ASINs arma la cesta oficial de amazon.es con cantidades', () => {
    expect(urlCestaAmazon([{ asin: 'b0abc12345' }, { asin: 'B0XYZ98765', cantidad: 2 }])).toBe(
      'https://www.amazon.es/gp/aws/cart/add.html?ASIN.1=B0ABC12345&Quantity.1=1&ASIN.2=B0XYZ98765&Quantity.2=2',
    );
    expect(urlCestaAmazon([{ asin: 'corto' }])).toBeNull();
    expect(urlCestaAmazon([{ asin: 'B0ABC12345', cantidad: 0 }])).toBeNull();
    expect(urlCestaAmazon([])).toBeNull();
  });

  it('solo acepta https sin usuario ni clave', () => {
    expect(enlacePagoValido('https://tienda.mercadona.es/cart')).toBe(
      'https://tienda.mercadona.es/cart',
    );
    expect(enlacePagoValido('http://tienda.es/pago')).toBeNull();
    expect(enlacePagoValido('https://yo:clave@tienda.es/pago')).toBeNull();
    expect(enlacePagoValido('javascript:alert(1)')).toBeNull();
    expect(enlacePagoValido(`https://tienda.es/${'x'.repeat(2100)}`)).toBeNull();
  });

  it('el botón dice «Pagar con Apple Pay en Safari» (Amazon: abrir la cesta) y el texto deja claro que no pagó', () => {
    const otro = mensajePago('Zapatillas', 'https://tienda.es/checkout');
    expect(otro.buttons).toEqual([
      { label: BOTON_APPLE_PAY, action: 'url:https://tienda.es/checkout' },
    ]);
    expect(BOTON_APPLE_PAY).toBe('Pagar con Apple Pay en Safari');
    expect(otro.text).toContain('Yo no he pagado nada');
    const amz = mensajePago(
      'Cápsulas',
      'https://www.amazon.es/gp/aws/cart/add.html?ASIN.1=B0ABC12345&Quantity.1=1',
    );
    expect(amz.buttons[0]?.label).toBe(BOTON_AMAZON);
    expect(amz.text).toContain('paga tú');
  });

  it('la herramienta manda el botón al chat del hilo y nunca paga', async () => {
    const { enviados, run } = tool();
    const r = await run({
      concepto: 'Cápsulas de café',
      amazon: [{ asin: 'B0ABC12345', cantidad: 3 }],
    });
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.chatId).toBe('42');
    expect(enviados[0]?.buttons[0]?.action).toBe(
      'url:https://www.amazon.es/gp/aws/cart/add.html?ASIN.1=B0ABC12345&Quantity.1=3',
    );
    expect(r).toContain('No se ha pagado nada');
  });

  it('un enlace malo no manda nada', async () => {
    const { enviados, run } = tool();
    expect(await run({ concepto: 'x', url: 'http://inseguro.es' })).toContain('https');
    expect(await run({ concepto: 'x' })).toContain('enlace');
    expect(enviados).toHaveLength(0);
  });

  it('está en el catálogo (sin ser libre ni de máquina) y en /funciones', () => {
    const c = CAPABILITIES.find((x) => x.name === 'enlace_pago');
    expect(c).toBeDefined();
    expect(c?.machine).toBeFalsy();
    expect(c?.threadAllow).toBeFalsy();
    expect(TOOL_ABILITIES.enlace_pago?.area).toBe('compras');
  });
});

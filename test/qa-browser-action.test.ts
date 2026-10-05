import { describe, expect, it } from 'vitest';
import { qaApproves } from '../src/channels/qa.js';

describe('qaApproves: acciones del navegador', () => {
  const q = (el: string, motivo = 'Parece una compra') =>
    `\u00bfPermito esta acci\u00f3n en el navegador?\nElemento: ${el}\nDatos de la p\u00e1gina:\nTotal 12,50 \u20ac cesta\nMotivo: ${motivo}`;

  it('aprueba escribir y anadir a la cesta aunque la pagina muestre euros', () => {
    expect(qaApproves(q('input | Buscar | texto'))).toBe(true);
    expect(qaApproves(q('button | A\u00f1adir a la cesta'))).toBe(true);
  });

  it('deniega el paso de pago: pagar, tarjeta, confirmar, checkout', () => {
    expect(qaApproves(q('button | Pagar ahora'))).toBe(false);
    expect(qaApproves(q('input | N\u00famero de tarjeta'))).toBe(false);
    expect(qaApproves(q('button | Confirmar pedido'))).toBe(false);
    expect(qaApproves(q('button | Continuar', 'p\u00e1gina de checkout'))).toBe(false);
    expect(qaApproves('\u00bfPermito esta acci\u00f3n en el navegador?\nMotivo: x')).toBe(false);
  });
});

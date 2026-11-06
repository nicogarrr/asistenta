import { describe, expect, it } from 'vitest';
import { compraIntent } from '../src/compra.js';

describe('lista de la compra: «faltan huevos» como se dice en casa', () => {
  it('apunta lo que falta', () => {
    expect(compraIntent('faltan huevos')).toEqual({ kind: 'add', items: ['huevos'] });
    expect(compraIntent('Falta leche y tomate')).toEqual({
      kind: 'add',
      items: ['leche', 'tomate'],
    });
    expect(compraIntent('se ha acabado el aceite')).toEqual({ kind: 'add', items: ['aceite'] });
    expect(compraIntent('no queda pan.')).toEqual({ kind: 'add', items: ['pan'] });
    expect(compraIntent('nos faltan yogures, plátanos y papel de cocina')).toEqual({
      kind: 'add',
      items: ['yogures', 'plátanos', 'papel de cocina'],
    });
  });
  it('no confunde frases que no son compra', () => {
    for (const t of [
      'falta poco',
      'faltan 5 minutos',
      'falta que me llames',
      'falta mucho para llegar',
      '¿qué falta?',
      'no queda nada',
      'falta alguien',
    ]) {
      expect(compraIntent(t)?.kind === 'add', t).toBe(false);
    }
  });
});

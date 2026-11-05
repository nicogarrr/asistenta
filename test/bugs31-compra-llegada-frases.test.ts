import { describe, expect, it } from 'vitest';
import { compraIntent } from '../src/compra.js';
import { llegadaIntent } from '../src/llegada.js';

describe('lista de la compra: más formas de decirlo', () => {
  it('«quita lo marcado», «borra los comprados», «vacía lo tachado de la compra»', () => {
    for (const t of [
      'quita lo marcado',
      'borra los comprados',
      'vacía lo tachado de la compra',
      'borra lo que ya está tachado',
      'vacía lo tachado',
    ])
      expect(compraIntent(t), t).toEqual({ kind: 'clearDone' });
  });

  it('«añade a la lista de la compra leche y pan»: la lista delante', () => {
    expect(compraIntent('añade a la lista de la compra leche y pan')).toEqual({
      kind: 'add',
      items: ['leche', 'pan'],
    });
    expect(compraIntent('apunta en la compra: tomates')).toEqual({
      kind: 'add',
      items: ['tomates'],
    });
    expect(compraIntent('añade leche a la lista de la compra')).toEqual({
      kind: 'add',
      items: ['leche'],
    });
  });
});

describe('avisos al llegar/salir: «me recuerdas», «que me recuerdes»', () => {
  it('se entienden como el «recuérdame» de siempre', () => {
    expect(llegadaIntent('cuando llegue a casa me recuerdas sacar la basura')).toEqual({
      place: 'casa',
      text: 'sacar la basura',
    });
    expect(llegadaIntent('cuando salga del gimnasio que me recuerdes la toalla')).toEqual({
      place: 'el gimnasio',
      text: 'la toalla',
      modo: 'salir',
    });
    expect(llegadaIntent('me avisas de llamar a Ana cuando llegue a Madrid')).toEqual({
      place: 'Madrid',
      text: 'llamar a Ana',
    });
  });
});

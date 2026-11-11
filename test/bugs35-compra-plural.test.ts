import { describe, expect, it } from 'vitest';
import { scaleIngredient } from '../src/compra-receta.js';
import { concordar, sumarLinea } from '../src/compra-sumar.js';

// bugs-35 (revisión de #2305 y #2316): al escalar una receta («/compra receta … para 6») o
// al sumar a lo que ya había en la lista, la cantidad cambiaba pero el texto no: «1 cebolla»
// para 6 → «2 cebolla», «1 diente de ajo» → «1,5 diente de ajo», y al bajar raciones
// «2 huevos» → «1 huevos».

describe('compra: el ingrediente concuerda con la cantidad nueva', () => {
  it('escalar hacia arriba pone el plural', () => {
    expect(scaleIngredient('1 cebolla', 1.5)).toBe('2 cebollas');
    expect(scaleIngredient('1 diente de ajo', 1.5)).toBe('1,5 dientes de ajo');
    expect(scaleIngredient('1 limón', 2)).toBe('2 limones');
    expect(scaleIngredient('1 pimiento rojo', 2)).toBe('2 pimientos rojos');
    expect(scaleIngredient('1 lata de tomate triturado', 2)).toBe('2 latas de tomate triturado');
    expect(scaleIngredient('1 cebolla grande, picada', 2)).toBe('2 cebollas grandes, picada');
  });

  it('escalar hacia abajo a 1 pone el singular', () => {
    expect(scaleIngredient('2 huevos', 0.5)).toBe('1 huevo');
    expect(scaleIngredient('2 limones', 0.5)).toBe('1 limón');
    expect(scaleIngredient('4 nueces', 0.25)).toBe('1 nuez');
    expect(scaleIngredient('2 dientes de ajo', 0.5)).toBe('1 diente de ajo');
  });

  it('lo que ya concordaba o va con unidad abreviada no se toca', () => {
    expect(scaleIngredient('200 g de harina', 1.5)).toBe('300 g de harina');
    expect(scaleIngredient('2 huevos', 1.5)).toBe('3 huevos');
    expect(scaleIngredient('1 cda de aceite', 2)).toBe('2 cda de aceite');
    expect(scaleIngredient('1 kg de patatas', 2)).toBe('2 kg de patatas');
  });

  it('sumar a la lista también concuerda', () => {
    expect(sumarLinea('½ cebolla', '1 cebolla')).toBe('2 cebollas');
    expect(sumarLinea('1 diente de ajo', '2 dientes de ajo')).toBe('3 dientes de ajo');
    expect(sumarLinea('1 huevo', '2 huevos')).toBe('3 huevos');
  });

  it('concordar: reglas sueltas', () => {
    expect(concordar(' calabacín', true)).toBe(' calabacines');
    expect(concordar(' pan', true)).toBe(' panes');
    expect(concordar(' yogur natural', true)).toBe(' yogures naturales');
    expect(concordar(' champiñones', false)).toBe(' champiñón');
    expect(concordar(' huevos', true)).toBe(' huevos');
  });
});

import { describe, expect, it } from 'vitest';
import { itemsFromText } from '../src/compra.js';

describe('compra: «e» delante de hi-', () => {
  it('separa «huevos e higos» y «pan e hilo»', () => {
    expect(itemsFromText('huevos e higos')).toEqual(['huevos', 'higos']);
    expect(itemsFromText('pan e hilo dental')).toEqual(['pan', 'hilo dental']);
  });
  it('no corta «e hielo» ni «e hierba» (hie-/hia- se dicen con «y»)', () => {
    expect(itemsFromText('leche e hierbabuena')).toEqual(['leche e hierbabuena']);
  });
  it('sigue separando «agua e infusiones»', () => {
    expect(itemsFromText('agua e infusiones')).toEqual(['agua', 'infusiones']);
  });
});

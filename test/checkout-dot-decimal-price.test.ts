import { describe, expect, it } from 'vitest';
import { parsePriceToCents, samePrice } from '../src/tools/checkout.js';

describe('parsePriceToCents: punto decimal', () => {
  it('«1299.99» y «12.34» son decimales, no miles', () => {
    expect(parsePriceToCents('1299.99')).toBe(129999);
    expect(parsePriceToCents('12.34')).toBe(1234);
    expect(parsePriceToCents('12.5')).toBe(1250);
  });

  it('el punto de miles sigue igual', () => {
    expect(parsePriceToCents('1.299')).toBe(129900);
    expect(parsePriceToCents('1.234,56')).toBe(123456);
    expect(parsePriceToCents('12.345.678')).toBe(1234567800);
    expect(parsePriceToCents('1 299,00')).toBe(129900);
  });

  it('samePrice ya no avisa «Ojo» por «1299.99» frente a «1.299,99»', () => {
    expect(samePrice('1299.99', '1.299,99')).toBe(true);
    expect(samePrice('12.34', '12,34')).toBe(true);
    expect(samePrice('12.34', '1.234,00')).toBe(false);
  });
});

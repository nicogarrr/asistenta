import { describe, expect, it, vi } from 'vitest';
import { tvCommand } from '../src/tv/tv-cli.js';

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
}

describe('pa tv orden: una orden con hora no se ejecuta y se dice por qué', () => {
  for (const words of [
    ['apaga', 'la', 'tele', 'en', '10', 'minutos'],
    ['pon', 'netflix', 'a', 'las', '9'],
    ['baja', 'el', 'volumen', 'cuando', 'acabe', 'el', 'partido'],
  ]) {
    it(words.join(' '), async () => {
      const { out, err, deps } = io();
      const runOrder = vi.fn(async () => 'x');
      expect(await tvCommand(['orden', ...words], { ...deps, runOrder })).toBe(2);
      expect(runOrder).not.toHaveBeenCalled();
      expect(out.join('')).toBe('');
      expect(err.join('')).toContain('lleva hora o condición');
      expect(err.join('')).toContain('no he tocado la tele');
    });
  }
  it('una orden sin hora sigue ejecutándose', async () => {
    const { deps } = io();
    const runOrder = vi.fn(async () => 'Tele apagada.');
    expect(await tvCommand(['orden', 'apaga', 'la', 'tele'], { ...deps, runOrder })).toBe(0);
    expect(runOrder).toHaveBeenCalledWith('apaga la tele');
  });
  it('lo que no se entiende sigue diciendo «No he entendido»', async () => {
    const { err, deps } = io();
    const runOrder = vi.fn(async () => 'x');
    expect(await tvCommand(['orden', 'haz', 'un', 'baile'], { ...deps, runOrder })).toBe(2);
    expect(err.join('')).toContain('No he entendido');
  });
});

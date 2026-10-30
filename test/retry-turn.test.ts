import { describe, expect, it } from 'vitest';
import { formatTokens, LastTurns, rewindLastTurn } from '../src/retry-turn.js';

describe('rewindLastTurn (/reintentar)', () => {
  const agent = {};
  it('quita lo que añadió el último turno', () => {
    const messages = ['u1', 'a1', 'ctx', 'u2', 'tool', 'a2'];
    const removed = rewindLastTurn(
      { agent, mark: 3, compactions: 0 },
      { agent, messages, compactions: 0 },
    );
    expect(removed).toBe(3);
    expect(messages).toEqual(['u1', 'a1', 'ctx']);
  });

  it('no toca nada si el historial se resumió, se reinició o es más corto', () => {
    const messages = ['s', 'u2', 'a2'];
    expect(
      rewindLastTurn({ agent, mark: 1, compactions: 0 }, { agent, messages, compactions: 1 }),
    ).toBe(0);
    expect(
      rewindLastTurn({ agent, mark: 1, compactions: 0 }, { agent: {}, messages, compactions: 0 }),
    ).toBe(0);
    expect(
      rewindLastTurn({ agent, mark: 9, compactions: 0 }, { agent, messages, compactions: 0 }),
    ).toBe(0);
    expect(messages).toHaveLength(3);
  });

  it('recuerda el último turno por conversación', () => {
    const turns = new LastTurns<object, string>();
    turns.remember('a', { text: 'hola', agent, mark: 0, compactions: 0 });
    turns.remember('b', { text: 'otra', agent, mark: 2, compactions: 0 });
    turns.remember('a', { text: 'segunda', images: ['x'], agent, mark: 4, compactions: 0 });
    expect(turns.get('a')?.text).toBe('segunda');
    expect(turns.get('a')?.images).toEqual(['x']);
    expect(turns.get('b')?.mark).toBe(2);
    turns.forget('a');
    expect(turns.get('a')).toBeUndefined();
  });

  it('formatTokens en español', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12345)).toBe('12,3 mil');
  });
});

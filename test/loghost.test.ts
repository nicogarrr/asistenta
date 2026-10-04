import { describe, expect, it } from 'vitest';
import { logHost } from '../src/log.js';

describe('logHost', () => {
  it('deja solo el host, sin ruta ni token', () => {
    expect(logHost('https://x.example.com/v/abc?token=SECRETO#f')).toBe('x.example.com');
  });
  it('no devuelve el texto si no es un enlace', () => {
    expect(logHost('esto no es url?token=SECRETO')).toBe('enlace-invalido');
  });
});

import { describe, expect, it } from 'vitest';
import { logHost, scrubUrls } from '../src/log.js';

describe('logHost', () => {
  it('deja solo el host, sin ruta ni token', () => {
    expect(logHost('https://x.example.com/v/abc?token=SECRETO#f')).toBe('x.example.com');
  });
  it('no devuelve el texto si no es un enlace', () => {
    expect(logHost('esto no es url?token=SECRETO')).toBe('enlace-invalido');
  });
});

describe('scrubUrls', () => {
  it('quita ruta y query de cualquier enlace del texto', () => {
    const out = scrubUrls(
      'ERROR: [youtube] https://www.youtube.com/watch?v=abc&token=SECRETO: sign in; ver http://x.es/a/b#c fin',
    );
    expect(out).not.toMatch(/SECRETO|watch|\/a\/b/);
    expect(out).toContain('https://www.youtube.com/…');
    expect(out).toContain('http://x.es/…');
  });
  it('no toca texto sin enlaces', () => {
    expect(scrubUrls('sin enlaces: 49,90 €')).toBe('sin enlaces: 49,90 €');
  });
});

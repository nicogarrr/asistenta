import { describe, expect, it } from 'vitest';
import { shorten } from '../src/channels/formatters.js';

// asis-bugs-1: un texto largo sin espacios (una tira de emojis) se cortaba a ciegas y
// podía quedar medio emoji (un par sustituto suelto) antes de «…».
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('shorten no parte un emoji por la mitad', () => {
  it('ningún corte deja un par sustituto suelto', () => {
    for (const n of [300, 999, 3999, 4000]) {
      for (const budget of [200, 201, 300, 301]) {
        for (const prefix of ['', 'a']) {
          const out = shorten(prefix + '😀'.repeat(n), budget);
          expect(out.truncated).toBe(true);
          expect(lone.test(out.text)).toBe(false);
        }
      }
    }
  });
});

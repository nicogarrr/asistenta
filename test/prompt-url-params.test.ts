import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/core/prompt.js';

describe('prompt: URL directa con parametros', () => {
  it('da la URL de busqueda de Booking y no inventa la de ALSA', () => {
    expect(SYSTEM_PROMPT).toContain('searchresults.html?ss=');
    expect(SYSTEM_PROMPT).toContain('checkin=YYYY-MM-DD');
    expect(SYSTEM_PROMPT).toContain('do not invent a URL');
  });
});

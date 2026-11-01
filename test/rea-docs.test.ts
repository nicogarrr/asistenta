import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('docs de REA', () => {
  it('la nota del equipo existe, da crédito (MIT) y marca los límites', () => {
    const doc = readFileSync(new URL('../docs/rea-equipo.md', import.meta.url), 'utf8');
    expect(doc).toContain('https://github.com/morluto/rea');
    expect(doc).toContain('MIT');
    expect(doc).toMatch(/solo lectura/);
    expect(doc).toMatch(/DRM/);
  });
});

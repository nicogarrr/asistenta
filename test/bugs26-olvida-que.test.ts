import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetRequest, SAID_PREFIX, statedFact } from '../src/memory/owner-facts.js';
import { ENTRY_SEPARATOR, MemorySnapshot } from '../src/memory/snapshot.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/**
 * «Olvida que mi dentista es el Dr. García» o «olvida lo que te dije del dentista» no se
 * reconocían como «olvida»: iban al modelo, que contesta pero no borra del perfil, y el
 * dato seguía en el prompt. Ahora se borran como «olvida lo del dentista».
 */
describe('olvidar un dato dicho con «olvida que…»', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'olv26-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reconoce las formas naturales', () => {
    expect(forgetRequest('olvida que mi dentista es el Dr. García')).toEqual({
      kind: 'match',
      query: 'mi dentista',
    });
    expect(forgetRequest('Olvida que mis padres viven en Sevilla.')).toEqual({
      kind: 'match',
      query: 'mis padres',
    });
    expect(forgetRequest('borra que vivo en Getafe')).toEqual({
      kind: 'match',
      query: 'vivo en Getafe',
    });
    expect(forgetRequest('olvídate de que me gusta el café solo')).toEqual({
      kind: 'match',
      query: 'me gusta el café solo',
    });
    expect(forgetRequest('olvida lo que te dije del dentista')).toEqual({
      kind: 'match',
      query: 'dentista',
    });
    expect(forgetRequest('olvida lo que te conté sobre mi hermana')).toEqual({
      kind: 'match',
      query: 'hermana',
    });
  });

  it('lo que no es un dato apuntable sigue yendo al modelo', () => {
    expect(forgetRequest('olvida que tengo cita mañana')).toBeNull();
    expect(forgetRequest('olvida que te he dicho eso, mira el correo')).toBeNull();
    expect(forgetRequest('borra que no se vea el archivo')).toBeNull();
    expect(forgetRequest('olvida la reunión de mañana y mira el correo')).toBeNull();
  });

  it('borra del perfil aunque el valor dicho ahora sea distinto', () => {
    const snapshot = new MemorySnapshot({ dir });
    for (const said of ['mi dentista es el Dr. García', 'vivo en Getafe']) {
      expect(snapshot.appendEntry(`${SAID_PREFIX} ${statedFact(said)}`).ok).toBe(true);
    }
    const f = forgetRequest('olvida que mi dentista es García');
    expect(f?.kind).toBe('match');
    expect(snapshot.removeEntries(f?.kind === 'match' ? f.query : '')).toBe(1);
    const left = snapshot.load().split(ENTRY_SEPARATOR).join('\n');
    expect(left).not.toMatch(/dentista/);
    expect(left).toMatch(/Getafe/);
  });
});

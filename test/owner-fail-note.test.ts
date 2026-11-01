import { describe, expect, it } from 'vitest';
import { OWNER_FAIL_WHAT, ownerFailNote } from '../src/cli.js';

const kinds = Object.keys(OWNER_FAIL_WHAT) as Array<keyof typeof OWNER_FAIL_WHAT>;

describe('ownerFailNote: errores de clip, directo, cámara+micro, perfil y skill sin texto técnico', () => {
  it('cubre los cinco sitios', () => {
    expect(kinds.sort()).toEqual(['camaraMicro', 'clip', 'directo', 'perfil', 'skill']);
  });

  for (const kind of kinds) {
    it(`${kind}: una traza técnica no llega al chat`, () => {
      const err = new Error(
        "TypeError: Cannot read properties of undefined (reading 'buf')\n    at capture (C:\\Users\\nico\\x.js:12:3)",
      );
      const r = ownerFailNote(kind, err);
      expect(r.startsWith(OWNER_FAIL_WHAT[kind])).toBe(true);
      expect(r).not.toMatch(/TypeError|undefined|Users|x\.js/);
    });

    it(`${kind}: un fallo de red sale en castellano`, () => {
      const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9222'), {
        code: 'ECONNREFUSED',
      });
      const r = ownerFailNote(kind, err);
      expect(r).not.toContain('ECONNREFUSED');
      expect(r).not.toContain('127.0.0.1');
    });

    it(`${kind}: un motivo ya en castellano se conserva`, () => {
      expect(ownerFailNote(kind, new Error('El texto del perfil no puede estar vacío'))).toBe(
        `${OWNER_FAIL_WHAT[kind]}: El texto del perfil no puede estar vacío`,
      );
    });
  }
});

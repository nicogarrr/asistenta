import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alreadySaid,
  factKey,
  factSavedLine,
  RecentFacts,
  supersededBy,
} from '../src/memory/owner-facts.js';
import { ENTRY_SEPARATOR, MemorySnapshot } from '../src/memory/snapshot.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/**
 * «Mi dentista es el Dr. López» con «Mi dentista es el Dr. García» ya apuntado dejaba los dos
 * en el perfil, y el modelo no sabía cuál valía. Decirlo dos veces lo apuntaba dos veces.
 * Ahora el dato nuevo sustituye al viejo (mismo sujeto) y la línea lo dice; las copias no se
 * apuntan.
 */
describe('memoria: un dato nuevo sustituye al viejo y no se apuntan copias', () => {
  it('el sujeto del dato: mismo sujeto y verbo, otra cosa con otro verbo', () => {
    expect(factKey('Mi dentista es el Dr. García')).toBe('mi dentista|es');
    expect(factKey('[dicho] Mi dentista es la Dra. Pérez')).toBe('mi dentista|es');
    expect(factKey('Mis padres viven en Sevilla')).toBe(factKey('mis padres viven en Cádiz'));
    expect(factKey('Mi hermana se llama Lucía')).not.toBe(factKey('Mi hermana vive en Bilbao'));
    expect(factKey('Vivo en Getafe')).toBe('vivo en');
    expect(factKey('Trabajo de enfermero')).toBe(factKey('Trabajo en Indra'));
    expect(factKey('Me gusta el café solo')).toBeNull();
    expect(factKey('Recuerda que odio el cilantro')).toBeNull();
  });

  const perfil = [
    '[dicho] Mi dentista es el Dr. García',
    '[auto] Mi hermana se llama Lucía',
    '[dicho] Vivo en Getafe',
    '[dicho] Me gusta el café solo',
  ];

  it('qué entradas quedan viejas', () => {
    expect(supersededBy(perfil, 'Mi dentista es el Dr. López')).toEqual([
      '[dicho] Mi dentista es el Dr. García',
    ]);
    expect(supersededBy(perfil, 'Vivo en Madrid')).toEqual(['[dicho] Vivo en Getafe']);
    expect(supersededBy(perfil, 'Mi hermana vive en Bilbao')).toEqual([]);
    expect(supersededBy(perfil, 'Me gusta el té')).toEqual([]);
    // Lo mismo otra vez no es «viejo»: es una copia.
    expect(supersededBy(perfil, 'Mi dentista es el Dr. García')).toEqual([]);
    expect(alreadySaid(perfil, 'mi dentista es el dr. garcia')).toBe(true);
    expect(alreadySaid(perfil, 'Mi dentista es el Dr. López')).toBe(false);
  });

  it('la línea dice qué había antes', () => {
    expect(factSavedLine('[dicho] Vivo en Madrid', ['[dicho] Vivo en Getafe'])).toBe(
      '📝 Actualizado: «Vivo en Madrid» (antes: «Vivo en Getafe»). Si no quieres que lo recuerde, dime «olvida eso».',
    );
    expect(factSavedLine('[dicho] Vivo en Madrid')).toContain('📝 Apuntado: «Vivo en Madrid»');
    const recent = new RecentFacts();
    recent.remember('c', '[dicho] Vivo en Madrid', 1_000, ['[dicho] Vivo en Getafe']);
    expect(recent.replacedOf('c', 2_000)).toEqual(['[dicho] Vivo en Getafe']);
    expect(recent.replacedOf('otro', 2_000)).toEqual([]);
  });

  describe('con el perfil de verdad', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ag1mem-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('quitar lo viejo y apuntar lo nuevo deja una sola versión', () => {
      const snap = new MemorySnapshot({ dir });
      for (const e of perfil) snap.appendEntry(e);
      const fact = 'Mi dentista es el Dr. López';
      for (const e of supersededBy(snap.load().split(ENTRY_SEPARATOR), fact)) snap.removeEntries(e);
      snap.appendEntry(`[dicho] ${fact}`);
      const now = snap
        .load()
        .split(ENTRY_SEPARATOR)
        .filter((e) => e.trim());
      expect(now.filter((e) => /dentista/i.test(e))).toEqual([
        '[dicho] Mi dentista es el Dr. López',
      ]);
      expect(now).toHaveLength(4);
    });
  });
});

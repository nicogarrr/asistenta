import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  aboutMeText,
  forgetRequest,
  isAboutMeRequest,
  RecentFacts,
  SAID_PREFIX,
  statedFact,
} from '../src/memory/owner-facts.js';
import { ENTRY_SEPARATOR, MemorySnapshot } from '../src/memory/snapshot.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/**
 * Como Tab: lo que el dueño cuenta de sí mismo se apunta, «¿qué sabes de mí?» lo
 * enseña y «olvida eso» lo borra. Perfil real en una carpeta temporal.
 */
const dir = mkdtempSync(join(tmpdir(), 'pa-como-tab-mem-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('frases que son un dato sobre él', () => {
  it.each([
    ['mi dentista es el Dr. García', 'Mi dentista es el Dr. García'],
    ['No me escribas antes de las 9', 'No me escribas antes de las 9'],
    ['recuerda que soy alérgico al marisco.', 'Recuerda que soy alérgico al marisco'],
    ['Mi hermana se llama Lucía', 'Mi hermana se llama Lucía'],
    ['vivo en Getafe, gracias', 'Vivo en Getafe'],
    ['prefiero que me hables de tú', 'Prefiero que me hables de tú'],
    ['soy vegetariano', 'Soy vegetariano'],
    ['tengo dos gatos', 'Tengo dos gatos'],
  ])('«%s» se apunta', (text, saved) => {
    expect(statedFact(text)).toBe(saved);
  });

  it.each([
    '¿mi dentista es el Dr. García?',
    'mi vuelo es mañana a las 7',
    'recuérdame llamar a mi madre',
    'mi jefe es un pesado, ayúdame con este correo',
    'si me duermo apaga la tele',
    'mi correo es raro. Míralo',
    'pon la tele',
    'mi',
  ])('«%s» no se apunta', (text) => {
    expect(statedFact(text)).toBeNull();
  });
});

describe('¿qué sabes de mí? y olvida eso', () => {
  it('reconoce la pregunta con y sin tildes', () => {
    expect(isAboutMeRequest('¿Qué sabes de mí?')).toBe(true);
    expect(isAboutMeRequest('que sabes de mi')).toBe(true);
    expect(isAboutMeRequest('qué recuerdas sobre mí')).toBe(true);
    expect(isAboutMeRequest('qué sabes de Madrid')).toBe(false);
  });

  it('reconoce «olvida eso» y «olvida lo de…»', () => {
    expect(forgetRequest('olvida eso')).toEqual({ kind: 'last' });
    expect(forgetRequest('Olvídalo.')).toEqual({ kind: 'last' });
    expect(forgetRequest('olvida lo del dentista')).toEqual({ kind: 'match', query: 'dentista' });
    expect(forgetRequest('borra lo de que vivo en Getafe')).toEqual({
      kind: 'match',
      query: 'vivo en Getafe',
    });
    expect(forgetRequest('olvida la reunión de mañana y mira el correo')).toBeNull();
  });

  it('apuntar, enseñar y olvidar con el perfil de verdad', () => {
    const snapshot = new MemorySnapshot({ dir });
    const recent = new RecentFacts();
    for (const said of ['mi dentista es el Dr. García', 'no me escribas antes de las 9']) {
      const entry = `${SAID_PREFIX} ${statedFact(said)}`;
      expect(snapshot.appendEntry(entry).ok).toBe(true);
      recent.remember('chat', entry, 1_000);
    }
    const shown = aboutMeText(snapshot.load().split(ENTRY_SEPARATOR));
    expect(shown).toMatch(/^Esto es lo que sé de ti:/);
    expect(shown).toContain('• Mi dentista es el Dr. García');
    expect(shown).not.toContain('[dicho]');

    // «olvida eso» borra lo último que se apuntó
    const last = recent.take('chat', 2_000);
    expect(last).toContain('antes de las 9');
    expect(snapshot.removeEntries(last ?? '')).toBe(1);
    expect(snapshot.load()).not.toContain('antes de las 9');
    // y «olvida lo del dentista» lo demás
    expect(snapshot.removeEntries('dentista')).toBe(1);
    expect(aboutMeText(snapshot.load().split(ENTRY_SEPARATOR))).toMatch(/Todavía no tengo nada/);
  });

  it('«olvida eso» pasada media hora ya no sabe qué es «eso»', () => {
    const recent = new RecentFacts();
    recent.remember('chat', 'x', 0);
    expect(recent.take('chat', 31 * 60_000)).toBeNull();
  });

  it('el daemon lo atiende en el chat privado del dueño antes del modelo', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain(
      'if (isOwnerDm(inbound, vigilanteOwnerId) && (await answerOwnerFacts(inbound))) return;',
    );
    expect(cli).toContain('if (nudge.worth && !factSaved)');
  });
});

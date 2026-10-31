import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CloseLoop, closedLine } from '../src/daemon/close-loop.js';
import { factSavedLine, forgotLine } from '../src/memory/owner-facts.js';

/**
 * Como Tab: al confirmar, se dice QUÉ se ha hecho («quito «dentista» de pendientes»),
 * no solo «hecho».
 */
describe('confirmaciones que nombran lo hecho', () => {
  it('«olvida eso» dice qué ha olvidado', () => {
    expect(forgotLine(['[dicho] Mi dentista es el Dr. García'])).toBe(
      'Hecho, ya no recuerdo «Mi dentista es el Dr. García».',
    );
    expect(forgotLine([])).toBe('Ya no lo tenía apuntado.');
    expect(forgotLine(['[dicho] Vivo en Getafe', '[auto] Trabajo en Madrid'])).toBe(
      'Hecho, he olvidado 2 cosas: «Vivo en Getafe», «Trabajo en Madrid».',
    );
    expect(forgotLine(['[dicho] a1', '[dicho] a2', '[dicho] a3', '[dicho] a4'])).toBe(
      'Hecho, he olvidado 4 cosas: «a1», «a2», «a3» y 1 más.',
    );
  });

  it('al apuntar algo dice qué ha apuntado', () => {
    expect(factSavedLine('[dicho] Mi dentista es el Dr. García')).toBe(
      '📝 Apuntado: «Mi dentista es el Dr. García». Si no quieres que lo recuerde, dime «olvida eso».',
    );
  });

  it('«ya está» tras «¿qué tal fue?» dice qué quita de pendientes', async () => {
    const now = 10 * 3_600_000;
    const loop = new CloseLoop({
      followups: () => [
        {
          id: 'f1',
          subject: 'Dentista el martes a las 10',
          dueAt: now - 3 * 3_600_000,
          status: 'pending',
        } as never,
      ],
      markAsked: () => {},
      resolve: () => {},
      send: async () => true,
      now: () => now,
      quiet: () => false,
      enabled: () => true,
    });
    expect(await loop.tick()).not.toBeNull();
    const closed = loop.answered('ya está', now + 60_000);
    expect(closed).toEqual({ id: 'f1', subject: 'Dentista el martes a las 10' });
    expect(closedLine(closed?.subject ?? '')).toBe(
      'Perfecto, quito «Dentista el martes a las 10» de pendientes.',
    );
  });

  it('el chat usa estas confirmaciones', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toContain('closedLine(closed.subject)');
    expect(cli).toContain('forgotLine(');
    expect(cli).toContain('factSavedLine(saidNow)');
    expect(cli).not.toContain("'Hecho, lo he olvidado.'");
    expect(cli).not.toContain("'Perfecto, lo quito de pendientes.'");
  });
});

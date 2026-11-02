import { describe, expect, it } from 'vitest';
import type { SubagentPool } from '../src/core/subagent.js';
import { createDelegateTool } from '../src/tools/delegate.js';

/**
 * Especialista que no existe (asis-expertos-4): antes el modelo solo recibía el texto
 * del hijo genérico y no sabía que su nombre no existía; el aviso iba solo en
 * `details`, que el modelo no lee. Ahora la respuesta lo dice y lista los nombres.
 */
function toolWith(result: { text: string; depth: number; error?: string }) {
  const seen: unknown[] = [];
  const pool = {
    run: async (req: unknown) => {
      seen.push(req);
      return result;
    },
  } as unknown as SubagentPool;
  return { tool: createDelegateTool(pool, () => 0), seen };
}

function textOf(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((c) => c.text ?? '').join('');
}

describe('delegate con un especialista que no existe', () => {
  it('la respuesta empieza avisando y nombra los especialistas que hay', async () => {
    const { tool, seen } = toolWith({ text: 'He mirado el horóscopo.', depth: 1 });
    const r = await tool.execute('t1', { task: 'mira esto', specialist: 'astrólogo' });
    const text = textOf(r);
    expect(text).toMatch(/^Aviso: no existe el especialista «astrólogo»/);
    expect(text).toContain('web, correo, calendario, notas, pc, tv, hogar');
    expect(text).toContain('subagente genérico');
    expect(text.endsWith('\n\nHe mirado el horóscopo.')).toBe(true);
    expect(r.details).toMatchObject({ unknownSpecialist: 'astrólogo' });
    // El hijo sigue siendo el genérico: no se le pasa ningún especialista.
    expect(seen[0]).not.toHaveProperty('specialist');
  });

  it('también avisa si el hijo genérico falla', async () => {
    const { tool } = toolWith({ text: '', depth: 1, error: 'El subagente se pasó de tiempo.' });
    const r = await tool.execute('t2', { task: 'x', specialist: 'banco' });
    const text = textOf(r);
    expect(text).toMatch(/^Aviso: no existe el especialista «banco»/);
    expect(text.endsWith('El subagente se pasó de tiempo.')).toBe(true);
  });

  it('el nombre se muestra en una línea y recortado', async () => {
    const { tool } = toolWith({ text: 'ok', depth: 1 });
    const r = await tool.execute('t3', { task: 'x', specialist: `a»\n«b${'z'.repeat(80)}` });
    const first = textOf(r).split('\n')[0] ?? '';
    expect(first).toMatch(/^Aviso: no existe el especialista «a bz+»/);
    expect(first).not.toContain('z'.repeat(41));
  });

  it('con un especialista que existe, o sin especialista, la respuesta no cambia', async () => {
    const { tool } = toolWith({ text: 'Hecho.', depth: 1 });
    expect(textOf(await tool.execute('t4', { task: 'x', specialist: 'la tele' }))).toBe('Hecho.');
    expect(textOf(await tool.execute('t5', { task: 'x' }))).toBe('Hecho.');
  });
});

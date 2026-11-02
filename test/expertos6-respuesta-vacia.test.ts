import { describe, expect, it } from 'vitest';
import type { SubagentPool, SubagentRequest, SubagentResult } from '../src/core/subagent.js';
import { createDelegateTool } from '../src/tools/delegate.js';

// Un subagente o especialista que termina sin decir nada (texto vacío, sin error):
// antes el modelo recibía un resultado vacío y Telegram ponía «🧩 Lo hizo el
// especialista …» (details.specialist sin error). Ahora el modelo lee que no volvió
// respuesta y que no lo dé por hecho, y details.error impide la línea 🧩.
function fakePool(result: SubagentResult): SubagentPool {
  return { run: async (_req: SubagentRequest) => result } as unknown as SubagentPool;
}

async function delegate(result: SubagentResult, args: Record<string, unknown>) {
  const tool = createDelegateTool(fakePool(result), () => 0);
  const out = await (tool.execute as (...a: unknown[]) => Promise<unknown>)('id', args, undefined);
  return out as {
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  };
}

describe('delegate con respuesta vacía', () => {
  it('especialista sin texto: el modelo lo sabe y no hay línea «Lo hizo»', async () => {
    const r = await delegate(
      { text: '', depth: 1 },
      { task: 'mira el correo', specialist: 'correo' },
    );
    const text = r.content[0]?.text ?? '';
    expect(text).toContain('sin devolver ninguna respuesta');
    expect(text).toContain('Correo');
    expect(text).toMatch(/no lo des por hecho/i);
    expect(r.details.specialist).toBe('correo');
    expect(typeof r.details.error).toBe('string');
  });

  it('solo espacios cuenta como vacío', async () => {
    const r = await delegate({ text: '  \n\t ', depth: 1 }, { task: 'busca algo' });
    expect(r.content[0]?.text).toContain('El subagente terminó sin devolver ninguna respuesta');
    expect(typeof r.details.error).toBe('string');
  });

  it('con especialista inexistente se mantiene el aviso del nombre', async () => {
    const r = await delegate({ text: '', depth: 1 }, { task: 'x', specialist: 'astrologo' });
    const text = r.content[0]?.text ?? '';
    expect(text).toContain('no existe el especialista «astrologo»');
    expect(text).toContain('sin devolver ninguna respuesta');
  });

  it('una respuesta normal no cambia', async () => {
    const r = await delegate(
      { text: 'Tienes 3 correos nuevos.', depth: 1 },
      { task: 'x', specialist: 'correo' },
    );
    expect(r.content[0]?.text).toBe('Tienes 3 correos nuevos.');
    expect(r.details).toEqual({ depth: 1, specialist: 'correo' });
  });

  it('un error del pool se sigue mostrando tal cual', async () => {
    const r = await delegate({ text: '', depth: 1, error: 'Tiempo agotado' }, { task: 'x' });
    expect(r.content[0]?.text).toBe('Tiempo agotado');
    expect(r.details.error).toBe('Tiempo agotado');
  });
});

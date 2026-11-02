import { describe, expect, it } from 'vitest';
import { SUBAGENT_STOPPED, SubagentPool, type SubagentRunRequest } from '../src/core/subagent.js';
import { createDelegateTool } from '../src/tools/delegate.js';

// Un especialista con efectos pide permiso, Nico dice que sí y la acción se hace;
// luego la tarea acaba en error (tiempo agotado, /stop, fallo del modelo). Antes el
// modelo principal solo leía el error y contaba que no se pudo, aunque la persiana ya
// estaba bajada. Ahora lee que hubo acciones aprobadas antes del fallo. No cambia
// ningún permiso: las respuestas del humano pasan tal cual.
type Approve = (q: string, signal?: AbortSignal) => Promise<boolean>;

function pool(run: (req: SubagentRunRequest) => Promise<{ text: string; error?: string | null }>) {
  return new SubagentPool({ run }, {}, { timeoutMs: 200 });
}

async function delegate(p: SubagentPool, answers: boolean[], signal?: AbortSignal) {
  let n = 0;
  const tool = createDelegateTool(p, () => 0, {
    parentTools: () => [],
    approve: async () => answers[n++] ?? false,
  });
  const out = (await (tool.execute as (...a: unknown[]) => Promise<unknown>)(
    'id',
    { task: 'baja la persiana y apaga la luz', specialist: 'casa' },
    signal,
  )) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  return { text: out.content[0]?.text ?? '', details: out.details };
}

const approveOf = (req: SubagentRunRequest) =>
  (req.context as { approve?: Approve } | undefined)?.approve;

describe('error del especialista después de acciones aprobadas', () => {
  it('error del hijo tras una acción aprobada: el modelo lo sabe', async () => {
    const r = await delegate(
      pool(async (req) => {
        await approveOf(req)?.('baja la persiana');
        return { text: '', error: 'El proveedor no respondió.' };
      }),
      [true],
    );
    expect(r.text).toContain('El proveedor no respondió.');
    expect(r.text).toContain('se aprobó 1 acción del especialista Casa');
    expect(r.text).toMatch(/no digas que no se hizo nada/i);
    expect(r.details.error).toBe('El proveedor no respondió.');
  });

  it('tiempo agotado tras dos aprobadas', async () => {
    const r = await delegate(
      pool(async (req) => {
        await approveOf(req)?.('a');
        await approveOf(req)?.('b');
        await new Promise((res) => setTimeout(res, 2_000));
        return { text: 'tarde' };
      }),
      [true, true],
    );
    expect(r.text).toContain('Tiempo agotado');
    expect(r.text).toContain('se aprobaron 2 acciones');
  });

  it('/stop tras una aprobada', async () => {
    const stop = new AbortController();
    const r = await delegate(
      pool(async (req) => {
        await approveOf(req)?.('a');
        stop.abort();
        await new Promise((res) => setTimeout(res, 2_000));
        return { text: 'tarde' };
      }),
      [true],
      stop.signal,
    );
    expect(r.text).toContain(SUBAGENT_STOPPED);
    expect(r.text).toContain('se aprobó 1 acción');
  });

  it('error sin nada aprobado (o denegado): el error tal cual', async () => {
    const r = await delegate(
      pool(async (req) => {
        await approveOf(req)?.('a');
        return { text: '', error: 'Falló.' };
      }),
      [false],
    );
    expect(r.text).toBe('Falló.');
    const r2 = await delegate(
      pool(async () => ({ text: '', error: 'Falló.' })),
      [],
    );
    expect(r2.text).toBe('Falló.');
  });

  it('bien terminado tras aprobar: igual que antes', async () => {
    const r = await delegate(
      pool(async (req) => {
        await approveOf(req)?.('a');
        return { text: 'Persiana bajada.' };
      }),
      [true],
    );
    expect(r.text).toBe('Persiana bajada.');
    expect(r.details).toEqual({ depth: 1, specialist: 'hogar' });
  });
});

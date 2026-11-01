import { describe, expect, it } from 'vitest';
import { type DeliverySetting, planDelivery } from '../src/routine-delivery.js';
import { avisoRoutineName, createGasolinerasTool } from '../src/tools/gasolineras.js';

// Con el Ministerio caído, la rutina del aviso «si baja de 1,40» escribía «No pude consultar
// los precios… Prueba en un rato.», como si el dueño hubiera preguntado. Como el aviso del
// BOE, la rutina lleva su marca y dice una frase fija (una vez por caída, por «solo si
// cambia»). La pregunta suelta sigue igual.

function harness() {
  const state = { down: true, t: Date.parse('2026-11-01T08:00:00Z') };
  const fetchFn = (async () =>
    state.down
      ? new Response('', { status: 503 })
      : new Response(JSON.stringify({ Fecha: '01/11/2026 8:36:16', ListaEESSPrecio: [] }), {
          status: 200,
        })) as unknown as typeof fetch;
  const routines = new Map<string, { scope: string; name: string; prompt: string }>();
  const store = {
    saveRoutine: (r: { scope: string; name: string; prompt: string }) => {
      routines.set(`${r.scope}|${r.name}`, r);
      return r as never;
    },
    deleteRoutine: (s: string, n: string) => routines.delete(`${s}|${n}`),
    getRoutine: (s: string, n: string) => (routines.get(`${s}|${n}`) ?? null) as never,
  };
  const settings = new Map<string, DeliverySetting & { lastHash?: string }>();
  const delivery = {
    set: (s: string, n: string, v: DeliverySetting) => settings.set(`${s}|${n}`, { ...v }),
    commit: (s: string, n: string, hash: string) => {
      const e = settings.get(`${s}|${n}`);
      if (e) e.lastHash = hash;
    },
  };
  const tool = createGasolinerasTool({
    fetchFn,
    now: () => new Date(state.t),
    env: {},
    store: store as never,
    scopeOf: () => 'tg:1',
    delivery,
  });
  const text = async (args: Record<string, unknown>) =>
    (await tool.execute('t', args as never)).content
      .map((c) => (c as { text: string }).text)
      .join('');
  const key = `tg:1|${avisoRoutineName('diesel')}`;
  const prompt = () => routines.get(key)?.prompt ?? '';
  const run = async (args: Record<string, unknown>): Promise<string | null> => {
    state.t += 10 * 3_600_000;
    const body = await text(args);
    const s = settings.get(key) as DeliverySetting & { lastHash?: string };
    const plan = planDelivery(s, s.lastHash, body);
    if (!plan.chat) return null;
    delivery.commit('tg:1', avisoRoutineName('diesel'), plan.hash);
    return body;
  };
  return { text, run, prompt };
}

describe('aviso de gasolineras con el Ministerio caído', () => {
  it('la rutina lleva la marca de rutina', async () => {
    const h = harness();
    await h.text({ aviso: 'activar', combustible: 'diesel', umbral: 1.4 });
    expect(h.prompt()).toContain('rutina true');
    expect(h.prompt()).toContain('umbral 1.4 ');
  });

  it('la rutina dice una frase fija, sin «prueba en un rato», y una sola vez por caída', async () => {
    const h = harness();
    await h.text({ aviso: 'activar', combustible: 'diesel', umbral: 1.4 });
    const args = { combustible: 'diesel', umbral: 1.4, rutina: true };
    const first = await h.run(args);
    expect(first).toBe(
      'Ahora no he podido mirar el precio del diésel: el Ministerio no respondía. Sigo mirando a las 9:00 y a las 19:00.',
    );
    expect(first).not.toContain('Prueba');
    expect(await h.run(args)).toBeNull();
  });

  it('la pregunta suelta sigue diciendo que pruebe en un rato', async () => {
    const h = harness();
    expect(await h.text({ combustible: 'diesel' })).toContain('Prueba en un rato.');
  });
});

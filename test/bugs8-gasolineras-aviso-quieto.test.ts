import { describe, expect, it } from 'vitest';
import { type DeliverySetting, planDelivery } from '../src/routine-delivery.js';
import { avisoRoutineName, createGasolinerasTool } from '../src/tools/gasolineras.js';

// El aviso «si baja de 1,40» prometía escribir solo cuando alguna gasolinera bajara. Pero
// tras un aviso (o tras un rato con el servicio caído), en la siguiente vuelta sin ninguna
// por debajo escribía «Ninguna gasolinera de Gijón tiene el diésel a 1,400 € o menos.»:
// «solo si cambia» lo comparaba con el último mensaje, que era otro. Como el aviso del
// BOE, el «nada» de la rutina pasa a ser lo último dicho y no se escribe.

const station = (precio: string) => ({
  Rótulo: 'PETROPRIX',
  Dirección: 'AVENIDA DE LOS CAMPONES, 2',
  Localidad: 'GIJON',
  Horario: 'L-D: 24H',
  'Precio Gasoleo A': precio,
});

function harness() {
  const state = { precio: '1,459', down: false, t: Date.parse('2026-11-01T08:00:00Z') };
  const fetchFn = (async () =>
    state.down
      ? new Response('', { status: 503 })
      : new Response(
          JSON.stringify({ Fecha: '01/11/2026 8:36:16', ListaEESSPrecio: [station(state.precio)] }),
          { status: 200 },
        )) as unknown as typeof fetch;
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
  /** Una vuelta de la rutina: lo que llegaría al chat, o null si «solo si cambia» lo calla. */
  const run = async (): Promise<string | null> => {
    state.t += 10 * 3_600_000; // 9:00 → 19:00: la caché de media hora ya no vale
    const body = await text({ combustible: 'diesel', umbral: 1.4 });
    const s = settings.get(key) as DeliverySetting & { lastHash?: string };
    const plan = planDelivery(s, s.lastHash, body);
    if (!plan.chat) return null;
    delivery.commit('tg:1', avisoRoutineName('diesel'), plan.hash);
    return body;
  };
  return { state, text, run };
}

describe('aviso de gasolineras: solo escribe cuando alguna baja', () => {
  it('tras avisar de una bajada, cuando vuelve a subir no escribe', async () => {
    const h = harness();
    await h.text({ aviso: 'activar', combustible: 'diesel', umbral: 1.4 });
    expect(await h.run()).toBeNull();
    h.state.precio = '1,389';
    expect(await h.run()).toContain('1,389 €');
    h.state.precio = '1,459';
    expect(await h.run()).toBeNull();
    h.state.precio = '1,379';
    expect(await h.run()).toContain('1,379 €');
  });

  it('tras un rato con el servicio caído, sin bajada no escribe «ninguna»', async () => {
    const h = harness();
    await h.text({ aviso: 'activar', combustible: 'diesel', umbral: 1.4 });
    h.state.down = true;
    expect(await h.run()).toContain('No pude');
    h.state.down = false;
    expect(await h.run()).toBeNull();
  });

  it('una pregunta suelta con otro umbral no toca el aviso', async () => {
    const h = harness();
    await h.text({ aviso: 'activar', combustible: 'diesel', umbral: 1.4 });
    h.state.precio = '1,389';
    expect(await h.run()).toContain('1,389 €');
    expect(await h.text({ combustible: 'diesel', umbral: 1.3 })).toContain('Ninguna');
    expect(await h.run()).toBeNull();
  });
});

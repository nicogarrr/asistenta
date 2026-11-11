import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BandejaQueue, MAX_RESUME_CUTS, type ProcesarDeps } from '../src/bandeja/procesar.js';
import { BandejaStore } from '../src/bandeja/store.js';

// bugs-32 (11 nov 2026): una cosa que se quedaba «procesando» al cerrarse Asistenta se
// retomaba en CADA arranque, para siempre. Si era la propia cosa la que tumbaba el daemon
// (un audio de 4 h que deja sin memoria al whisper del PC), el PC entraba en un bucle de
// arrancar → transcribir → caerse.

const CHAT = '111';
const NOV11 = new Date('2026-11-11T09:00:00Z');
const REPLY =
  'TITULO: T\nVEREDICTO: IDEAS\nNOTA: 6\nMOTIVO: m\nIDEAS:\n- a\n- b\n- c\nETIQUETAS: ninguna';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugs32-reinicio-'));
  file = join(dir, 'bandeja.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const never: ProcesarDeps = {
  // El daemon «se cae» a mitad: el modelo nunca contesta.
  complete: async () => () => new Promise<string>(() => {}),
  fetchRaw: async () => '',
  videoText: async () => ({ ok: false, reason: 'no' }),
};

/** Un arranque del daemon: abre la base, retoma, y «se cae» (cierra) a mitad. */
async function boot(deps: ProcesarDeps): Promise<{ resumed: number; store: BandejaStore }> {
  const store = new BandejaStore(file);
  const queue = new BandejaQueue(store, deps);
  const resumed = queue.resume();
  await new Promise((r) => setTimeout(r, 20));
  return { resumed, store };
}

describe('bandeja: retomar al arrancar sin bucles', () => {
  it('una cosa que se corta a medias se retoma, pero a la tercera queda en ⚠️ con su motivo', async () => {
    const first = new BandejaStore(file);
    const { item } = first.add(
      CHAT,
      { kind: 'texto', title: 'x', note: 'x '.repeat(60) },
      NOV11,
      '2026-11-11',
    );
    first.setStatus(item.id, 'procesando'); // el PC se apagó con esto a medias
    first.close();
    const runs: number[] = [];
    for (let boots = 1; boots <= MAX_RESUME_CUTS + 2; boots++) {
      const { resumed, store } = await boot(never);
      runs.push(resumed);
      store.close();
    }
    expect(runs.slice(0, MAX_RESUME_CUTS - 1).every((n) => n === 1)).toBe(true);
    expect(runs.slice(MAX_RESUME_CUTS - 1).every((n) => n === 0)).toBe(true);
    const store = new BandejaStore(file);
    expect(store.get(item.id)).toMatchObject({ status: 'error' });
    expect(store.get(item.id)?.error).toMatch(/se cortó 3 veces/);
    store.close();
  });

  it('si al retomarla termina, se olvida la cuenta (un corte suelto otro día no la condena)', async () => {
    const first = new BandejaStore(file);
    const { item } = first.add(
      CHAT,
      { kind: 'texto', title: 'x', note: 'x '.repeat(60) },
      NOV11,
      '2026-11-11',
    );
    first.setStatus(item.id, 'procesando');
    first.close();
    const ok: ProcesarDeps = { ...never, complete: async () => async () => REPLY };
    const store = new BandejaStore(file);
    const queue = new BandejaQueue(store, ok);
    expect(queue.resume()).toBe(1);
    await queue.idle();
    expect(store.get(item.id)?.status).toBe('listo');
    expect(store.getMeta(`cortes:${item.id}`)).toBeNull();
    store.close();
  });

  it('lo «nuevo» (aún sin empezar) se retoma siempre', async () => {
    const first = new BandejaStore(file);
    first.add(CHAT, { kind: 'texto', title: 'x', note: 'x '.repeat(60) }, NOV11, '2026-11-11');
    first.close();
    for (let i = 0; i < MAX_RESUME_CUTS + 1; i++) {
      const store = new BandejaStore(file);
      // Sin cola que la toque: sigue «nueva».
      expect(store.unprocessed()).toHaveLength(1);
      store.close();
    }
  });
});

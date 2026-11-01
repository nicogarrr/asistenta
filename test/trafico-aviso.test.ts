import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import { outputHash } from '../src/routine-delivery.js';
import {
  AVISO_SCHEDULE,
  avisoRoutineName,
  createTraficoTool,
  sinNovedad,
  TraficoVistosStore,
} from '../src/tools/trafico.js';

// El mismo feed recortado de la DGT (1-nov-2026, 10:47) que usa trafico-tool.test.ts.
const XML = readFileSync(new URL('./fixtures/dgt-trafico.xml', import.meta.url), 'utf8');
/** El feed sin la incidencia de un municipio: así, al volver, es «nueva». */
const sin = (municipio: string): string =>
  XML.replace(/<sit:situationRecord\b[\s\S]*?<\/sit:situationRecord>/g, (r) =>
    r.includes(`>${municipio}<`) ? '' : r,
  );

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

function harness(feeds: (string | null)[]) {
  const routines = new Map<string, { schedule: string | null; prompt: string | null }>();
  const store = {
    saveRoutine: (r: {
      scope: string;
      name: string;
      schedule?: string | null;
      prompt?: string | null;
    }) => {
      routines.set(`${r.scope}|${r.name}`, {
        schedule: r.schedule ?? null,
        prompt: r.prompt ?? null,
      });
      return r as never;
    },
    deleteRoutine: (scope: string, name: string) => routines.delete(`${scope}|${name}`),
    getRoutine: (scope: string, name: string) =>
      (routines.has(`${scope}|${name}`) ? { scope, name } : null) as never,
    listRoutines: (scope?: string) =>
      [...routines.entries()]
        .map(([k, v]) => [...k.split('|'), v.prompt] as [string, string, string | null])
        .filter(([s]) => !scope || s === scope)
        .map(([s, name, prompt]) => ({ scope: s, name, prompt })) as never,
  };
  const settings: unknown[] = [];
  const commits: [string, string][] = [];
  let clock = new Date('2026-11-01T09:50:00Z').getTime(); // 10:50 en Madrid
  let calls = 0;
  const fetchFn = (async () => {
    const xml = feeds[Math.min(calls, feeds.length - 1)];
    calls += 1;
    if (xml === null) throw new Error('ECONNRESET');
    return new Response(xml, { status: 200 });
  }) as unknown as typeof fetch;
  const t = createTraficoTool({
    fetchFn,
    env: {},
    now: () => new Date(clock),
    store,
    scopeOf: () => 'chat1',
    sync: () => {},
    delivery: {
      set: (_s, name, setting) => settings.push([name, setting]),
      commit: (_s, name, hash) => commits.push([name, hash]),
    },
  });
  /** Pasa media hora (más que la caché de 5 min) y corre la rutina como lo haría el modelo. */
  const vuelta = async (carretera: string, provincia: string, nivel: string, minutes = 30) => {
    clock += minutes * 60_000;
    return textOf(await t.execute('t', { carretera, provincia, nivel, rutina: true } as never));
  };
  return { t, routines, settings, commits, vuelta, calls: () => calls };
}

describe('aviso del tráfico: «avísame si hay algo en la A-8»', () => {
  it('lo enciende con lo que hay ahora como visto y solo escribe lo nuevo, una vez', async () => {
    const h = harness([sin('Carreño'), sin('Carreño'), XML]);
    expect(textOf(await h.t.execute('t', { aviso: 'activar' }))).toBe(
      '¿De qué carretera te aviso? Dímela como la nombra la DGT, por ejemplo la A-8 o la AS-II.',
    );
    const on = textOf(await h.t.execute('t', { aviso: 'activar', carretera: ' a-8 ' }));
    expect(on).toBe(
      'Hecho: miro la A-8 en Asturias cada media hora, de 6:00 a 22:00, y solo te escribo si aparece cualquier incidencia nueva. Ahora mismo hay 3; de esas no te aviso. Para quitarlo, dime «quita el aviso del tráfico».',
    );
    const name = avisoRoutineName('a-8');
    expect(name).toBe('aviso tráfico: A-8');
    expect(AVISO_SCHEDULE).toBe('*/30 6-21 * * *');
    const r = h.routines.get(`chat1|${name}`);
    expect(r?.schedule).toBe(AVISO_SCHEDULE);
    expect(r?.prompt).toContain(
      'carretera «A-8», provincia «Asturias», nivel «todo» y rutina true',
    );
    expect(h.settings).toEqual([[name, { target: 'chat', soloSiCambia: true }]]);
    expect(h.commits).toEqual([[name, outputHash(sinNovedad('A-8'))]]);

    // Nada nuevo: el texto fijo, ya dado por dicho, así «solo si cambia» lo calla.
    expect(await h.vuelta('A-8', 'Asturias', 'todo')).toBe('Nada nuevo en la A-8.');
    expect(h.commits).toHaveLength(2);
    // Aparece el vehículo detenido de Carreño: solo esa línea.
    expect(await h.vuelta('A-8', 'Asturias', 'todo')).toBe(
      [
        'Tráfico: novedad en la A-8 (Asturias).',
        '• A-8, km 398,2 (Carreño): vehículo detenido, desde las 10:40.',
      ].join('\n'),
    );
    expect(h.commits).toHaveLength(2);
    // La media hora siguiente sigue ahí: no se repite, y «nada nuevo» vuelve a ser lo dicho.
    expect(await h.vuelta('A-8', 'Asturias', 'todo')).toBe('Nada nuevo en la A-8.');
    expect(h.commits.at(-1)).toEqual([name, outputHash(sinNovedad('A-8'))]);
  });

  it('«avísame si cortan la MO-1»: solo los cortes; lo demás no escribe', async () => {
    const h = harness([sin('Morcín'), XML]);
    const on = textOf(
      await h.t.execute('t', { aviso: 'activar', carretera: 'MO-1', nivel: 'cortes' }),
    );
    expect(on).toBe(
      'Hecho: miro la MO-1 en Asturias cada media hora, de 6:00 a 22:00, y solo te escribo si aparece un corte nuevo. Ahora mismo no hay nada. Para quitarlo, dime «quita el aviso del tráfico».',
    );
    expect(await h.vuelta('MO-1', 'Asturias', 'cortes')).toBe(
      [
        'Tráfico: novedad en la MO-1 (Asturias).',
        '• MO-1, km 4,55 a 4,58 (Morcín): calzada cortada por obras, hasta el 3 de noviembre.',
      ].join('\n'),
    );

    // En la A-8 solo con cortes: el vehículo detenido nuevo no es un corte.
    const a8 = harness([sin('Carreño'), XML]);
    await a8.t.execute('t', { aviso: 'activar', carretera: 'A-8', nivel: 'cortes' });
    expect(await a8.vuelta('A-8', 'Asturias', 'cortes')).toBe('Nada nuevo en la A-8.');
    // «graves» sí lo cuenta.
    const g = harness([sin('Carreño'), XML]);
    expect(
      textOf(await g.t.execute('t', { aviso: 'activar', carretera: 'A-8', nivel: 'graves' })),
    ).toContain(
      'si aparece algo grave nuevo (un accidente, retenciones, un vehículo parado o un corte). Ahora mismo hay una; de esa no te aviso.',
    );
    expect(await g.vuelta('A-8', 'Asturias', 'graves')).toContain('vehículo detenido');
  });

  it('DGT caída: al encenderlo, la primera vuelta solo apunta; en una vuelta, calla', async () => {
    const h = harness([null, XML, null, sin('Gijón'), XML]);
    const on = textOf(await h.t.execute('t', { aviso: 'activar', carretera: 'A-8' }));
    expect(on).toBe(
      'Hecho: miro la A-8 en Asturias cada media hora, de 6:00 a 22:00, y solo te escribo si aparece cualquier incidencia nueva. Para quitarlo, dime «quita el aviso del tráfico».',
    );
    expect(await h.vuelta('A-8', 'Asturias', 'todo')).toBe('Nada nuevo en la A-8.');
    expect(await h.vuelta('A-8', 'Asturias', 'todo')).toBe('Nada nuevo en la A-8.');
    expect(h.commits).toHaveLength(3);
    // Las obras de Gijón desaparecen una vuelta y vuelven: es la misma, no se repite.
    expect(await h.vuelta('A-8', 'Asturias', 'todo')).toBe('Nada nuevo en la A-8.');
    expect(await h.vuelta('A-8', 'Asturias', 'todo')).toBe('Nada nuevo en la A-8.');
  });

  it('lo olvidado tras 12 h sin salir vuelve a ser noticia', async () => {
    const h = harness([XML, sin('Carreño'), XML]);
    await h.t.execute('t', { aviso: 'activar', carretera: 'A-8' });
    expect(await h.vuelta('A-8', 'Asturias', 'todo', 13 * 60)).toBe('Nada nuevo en la A-8.');
    expect(await h.vuelta('A-8', 'Asturias', 'todo')).toContain('(Carreño): vehículo detenido');
  });

  it('una carretera, un aviso; toda España; ver y quitar', async () => {
    const h = harness([XML]);
    await h.t.execute('t', { aviso: 'activar', carretera: 'A-8' });
    await h.t.execute('t', { aviso: 'activar', carretera: 'a8', nivel: 'cortes' });
    expect(
      textOf(
        await h.t.execute('t', { aviso: 'activar', carretera: 'AS-II', provincia: 'toda España' }),
      ),
    ).toContain('Hecho: miro la AS-II en toda España cada media hora');
    expect([...h.routines.keys()]).toEqual([
      'chat1|aviso tráfico: A8',
      'chat1|aviso tráfico: AS-II',
    ]);
    expect(h.routines.get('chat1|aviso tráfico: AS-II')?.prompt).toContain('provincia «España»');
    expect(textOf(await h.t.execute('t', { aviso: 'ver' }))).toBe(
      'Vigilo el tráfico (cada media hora, de 6:00 a 22:00) en la A8 en Asturias (cortes) y la AS-II en toda España (todo).',
    );
    expect(textOf(await h.t.execute('t', { aviso: 'desactivar', carretera: 'A-8' }))).toBe(
      'Hecho: ya no vigilo el tráfico en la A8.',
    );
    expect(textOf(await h.t.execute('t', { aviso: 'desactivar', carretera: 'N-634' }))).toBe(
      'No tenía ningún aviso del tráfico en la N-634.',
    );
    expect(textOf(await h.t.execute('t', { aviso: 'desactivar' }))).toBe(
      'Hecho: ya no vigilo el tráfico en la AS-II.',
    );
    expect(textOf(await h.t.execute('t', { aviso: 'desactivar' }))).toBe(
      'No tenías ningún aviso del tráfico.',
    );
    expect(textOf(await h.t.execute('t', { aviso: 'ver' }))).toBe(
      'No tienes ningún aviso del tráfico.',
    );
  });

  it('sin rutinas a mano, el aviso no se ofrece', async () => {
    const t = createTraficoTool({ fetchFn: (async () => new Response(XML)) as never, env: {} });
    expect(textOf(await t.execute('t', { aviso: 'activar', carretera: 'A-8' }))).toBe(
      'El aviso del tráfico no está disponible aquí.',
    );
  });

  it('lo visto se guarda en un JSON local y sobrevive a un reinicio', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-trafico-'));
    try {
      const file = join(dir, 'state', 'trafico-avisos.json');
      new TraficoVistosStore(file).set('chat1', 'aviso tráfico: A-8', {
        sembrado: true,
        vistos: { 'A-8|398,2|vehicleObstruction|vehicleStuck': '2026-11-01T09:50:00.000Z' },
      });
      const again = new TraficoVistosStore(file);
      expect(again.get('chat1', 'aviso tráfico: A-8')?.vistos).toHaveProperty(
        'A-8|398,2|vehicleObstruction|vehicleStuck',
      );
      again.set('chat1', 'aviso tráfico: A-8', undefined);
      expect(new TraficoVistosStore(file).get('chat1', 'aviso tráfico: A-8')).toBeUndefined();
      expect(new TraficoVistosStore(join(dir, 'no-existe.json')).get('x', 'y')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('la puerta: consultar y la rutina leen; encender o quitar el aviso escribe local', () => {
    const gate = new Gate({ approver: () => true });
    const kind = (args: Record<string, unknown>) =>
      gate.classifyEffect({ tool: 'trafico', args, actor: 'test' });
    expect(kind({ carretera: 'A-8' })).toBe('lee');
    expect(kind({ carretera: 'A-8', rutina: true })).toBe('lee');
    expect(kind({ aviso: 'ver' })).toBe('lee');
    expect(kind({ aviso: 'activar', carretera: 'A-8' })).toBe('escribe-local');
    expect(kind({ aviso: 'desactivar' })).toBe('escribe-local');
  });
});

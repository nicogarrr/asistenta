import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import { outputHash } from '../src/routine-delivery.js';
import {
  AVISO_SCHEDULE,
  avisoRoutineName,
  createGasolinerasTool,
  parseGasolineras,
  parsePrecio,
  sinNovedad,
  titulo,
} from '../src/tools/gasolineras.js';

// Respuesta del Ministerio para Gijón (1-nov-2026), recortada a 6 gasolineras.
const GIJON = {
  Fecha: '01/11/2026 8:36:16',
  ListaEESSPrecio: [
    {
      Rótulo: 'PETROPRIX',
      Dirección: 'AVENIDA DE LOS CAMPONES, 2',
      Localidad: 'GIJON',
      Horario: 'L-D: 24H',
      'Precio Gasoleo A': '1,799',
      'Precio Gasolina 95 E5': '1,674',
      'Precio Gasolina 98 E5': '',
    },
    {
      Rótulo: 'ALCAMPO',
      Dirección: 'AUTOPISTA AS -2 KM. 22',
      Localidad: 'GIJON',
      Horario: 'L-D: 24H',
      'Precio Gasoleo A': '1,809',
      'Precio Gasolina 95 E5': '1,674',
      'Precio Gasolina 98 E5': '1,812',
    },
    {
      Rótulo: 'BALLENOIL',
      Dirección: 'AVENIDA ROCES, N',
      Localidad: 'GIJON',
      Horario: 'L-D: 24H',
      'Precio Gasoleo A': '1,819',
      'Precio Gasolina 95 E5': '1,674',
      'Precio Gasolina 98 E5': '',
    },
    {
      Rótulo: 'BALLENOIL',
      Dirección: 'AVENIDA CAMPONES, 14',
      Localidad: 'GIJON',
      Horario: 'L-D: 24H',
      'Precio Gasoleo A': '',
      'Precio Gasolina 95 E5': '1,674',
      'Precio Gasolina 98 E5': '',
    },
    {
      Rótulo: 'EMPRESOIL',
      Dirección: 'CALLE PAULINA CANGA, 4',
      Localidad: 'GIJON',
      Horario: 'L-S: 06:00-22:00',
      'Precio Gasoleo A': '2,029',
      'Precio Gasolina 95 E5': '1,839',
      'Precio Gasolina 98 E5': '1,939',
    },
    {
      Rótulo: 'REPSOL',
      Dirección: 'CARRETERA AS-248 KM. 20',
      Localidad: 'GIJON',
      Horario: 'L-D: 06:00-23:00',
      'Precio Gasoleo A': '2,039',
      'Precio Gasolina 95 E5': '1,835',
      'Precio Gasolina 98 E5': '1,945',
    },
  ],
  ResultadoConsulta: 'OK',
};

const MUNICIPIOS = [
  { IDMunicipio: '4987', Municipio: 'Gijón', Provincia: 'ASTURIAS' },
  { IDMunicipio: '5006', Municipio: 'Oviedo', Provincia: 'ASTURIAS' },
];

const fake = (urls: string[]): typeof fetch =>
  (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith('/Listados/Municipios/'))
      return new Response(JSON.stringify(MUNICIPIOS), { status: 200 });
    if (/FiltroMunicipio\/(4987|5006)$/.test(u))
      return new Response(JSON.stringify(GIJON), { status: 200 });
    return new Response('', { status: 404 });
  }) as typeof fetch;

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

const tool = (env: NodeJS.ProcessEnv = {}, urls: string[] = []) =>
  createGasolinerasTool({ fetchFn: fake(urls), env });

describe('tool gasolineras: «¿dónde echo gasolina más barata?»', () => {
  it('lee precios con coma y ordena de más barata a más cara', () => {
    expect(parsePrecio('1,459')).toBe(1.459);
    expect(parsePrecio('')).toBeNull();
    expect(titulo('AVENIDA DE LOS CAMPONES, 2')).toBe('Avenida de los Campones, 2');
    const d = parseGasolineras(GIJON, 'diesel');
    expect(d.map((g) => g.precio)).toEqual([1.799, 1.809, 1.819, 2.029, 2.039]);
    expect(d[0]?.marca).toBe('Petroprix');
    expect(parseGasolineras({ nada: 1 }, 'diesel')).toEqual([]);
  });

  it('por defecto Gijón, diésel y gasolina 95, con la hora de los precios', async () => {
    const urls: string[] = [];
    const out = textOf(await tool({}, urls).execute('t', { cuantas: 2 }));
    expect(out).toContain('Gasolineras más baratas en Gijón (precios de las 8:36):');
    expect(out).toContain(
      'Diésel:\n1. 1,799 € — Petroprix, Avenida de los Campones, 2 (24 h)\n2. 1,809 € — Alcampo',
    );
    expect(out).toContain('Gasolina 95:\n1. 1,674 €');
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').host).toBe('sedeaplicaciones.minetur.gob.es');
    expect(urls[0]).toMatch(/FiltroMunicipio\/4987$/);
  });

  it('un combustible: PA_CARBURANTE o el que pida', async () => {
    const a = textOf(await tool({ PA_CARBURANTE: 'gasoleo_a' }).execute('t', { cuantas: 1 }));
    expect(a).toContain('Diésel:');
    expect(a).not.toContain('Gasolina 95');
    const b = textOf(await tool().execute('t', { combustible: 'gasolina98', cuantas: 1 }));
    expect(b).toContain('Gasolina 98:\n1. 1,812 € — Alcampo, Autopista As -2 Km. 22 (24 h)');
  });

  it('otro municipio por nombre (sin tildes también)', async () => {
    const urls: string[] = [];
    const out = textOf(await tool({ PA_GASOLINERAS_MUNICIPIO: 'oviedo' }, urls).execute('t', {}));
    expect(out).toContain('en Oviedo');
    expect(urls.some((u) => u.endsWith('FiltroMunicipio/5006'))).toBe(true);
    const none = textOf(await tool({ PA_GASOLINERAS_MUNICIPIO: 'Atlántida' }).execute('t', {}));
    expect(none).toContain('No encuentro el municipio');
  });

  it('«¿hay alguna por debajo de 1,81?»', async () => {
    const yes = textOf(await tool().execute('t', { combustible: 'diesel', umbral: 1.81 }));
    expect(yes).toContain('Diésel a 1,810 € o menos en Gijón:\n1. 1,799 €');
    expect(yes).toContain('2. 1,809 €');
    expect(yes).not.toContain('1,819');
    const no = textOf(await tool().execute('t', { combustible: 'diesel', umbral: 1.5 }));
    expect(no).toBe(sinNovedad('diesel', 1.5, 'Gijón'));
    expect(no).toBe('Ninguna gasolinera de Gijón tiene el diésel a 1,500 € o menos.');
  });

  it('servicio caído, sin red o lento: mensaje amable sin el error crudo', async () => {
    const off = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const a = textOf(await createGasolinerasTool({ fetchFn: off, env: {} }).execute('t', {}));
    expect(a).toContain('No pude consultar los precios de las gasolineras');
    expect(a).not.toContain('fetch failed');
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const b = textOf(await createGasolinerasTool({ fetchFn: down, env: {} }).execute('t', {}));
    expect(b).not.toMatch(/503|HTTP/);
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch;
    const c = textOf(
      await createGasolinerasTool({ fetchFn: hang, env: {}, timeoutMs: 20 }).execute('t', {}),
    );
    expect(c).toContain('No pude consultar los precios de las gasolineras');
  });

  it('caché de media hora: dos preguntas, una llamada', async () => {
    const urls: string[] = [];
    const t = tool({}, urls);
    await t.execute('t', {});
    await t.execute('t', { combustible: 'diesel', umbral: 1.8 });
    expect(urls).toHaveLength(1);
  });

  it('el aviso «si baja de X»: pregunta lo que falta, crea la rutina «solo si cambia» y se quita', async () => {
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
    };
    const settings = new Map<string, { soloSiCambia: boolean; hash?: string }>();
    const delivery = {
      set: (scope: string, name: string, s: { soloSiCambia: boolean }) =>
        settings.set(`${scope}|${name}`, { soloSiCambia: s.soloSiCambia }),
      commit: (scope: string, name: string, hash: string) => {
        const e = settings.get(`${scope}|${name}`);
        if (e) e.hash = hash;
      },
    };
    let synced = 0;
    const t = createGasolinerasTool({
      fetchFn: fake([]),
      env: {},
      store: store as never,
      scopeOf: () => 'tg:1',
      sync: () => {
        synced++;
      },
      delivery,
    });
    expect(textOf(await t.execute('t', { aviso: 'activar', umbral: 1.4 }))).toContain(
      '¿Para qué combustible',
    );
    expect(textOf(await t.execute('t', { aviso: 'activar', combustible: 'diesel' }))).toContain(
      '¿Por debajo de qué precio',
    );
    expect(routines.size).toBe(0);
    const on = textOf(
      await t.execute('t', { aviso: 'activar', combustible: 'diesel', umbral: 1.4 }),
    );
    expect(on).toContain('miro a las 9:00 y a las 19:00');
    expect(on).toContain('diésel a 1,400 € o menos');
    const key = `tg:1|${avisoRoutineName('diesel')}`;
    expect(routines.get(key)?.schedule).toBe(AVISO_SCHEDULE);
    expect(routines.get(key)?.prompt).toContain('umbral 1.4');
    expect(settings.get(key)).toEqual({
      soloSiCambia: true,
      hash: outputHash(sinNovedad('diesel', 1.4, 'Gijón')),
    });
    expect(textOf(await t.execute('t', { aviso: 'desactivar' }))).toContain(
      'quito el aviso de diésel',
    );
    expect(routines.size).toBe(0);
    expect(textOf(await t.execute('t', { aviso: 'desactivar' }))).toContain('No tenías');
    expect(synced).toBe(2);
  });

  it('la puerta: consultar es lectura; el aviso escribe solo en local', () => {
    const gate = new Gate({ approver: () => true });
    expect(gate.classifyEffect({ tool: 'gasolineras', args: { umbral: 1.4 }, actor: 'test' })).toBe(
      'lee',
    );
    expect(
      gate.classifyEffect({
        tool: 'gasolineras',
        args: { aviso: 'activar', umbral: 1.4 },
        actor: 'test',
      }),
    ).toBe('escribe-local');
  });
});

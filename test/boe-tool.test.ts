import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import { outputHash } from '../src/routine-delivery.js';
import {
  AVISO_SCHEDULE,
  avisoRoutineName,
  coincide,
  createBoeTool,
  parseSumario,
  sinNovedad,
} from '../src/tools/boe.js';

// Sumario del BOE del viernes 30-oct-2026 (API de datos abiertos), recortado. La API
// convierte su XML a JSON: una lista de un solo elemento llega como objeto suelto.
const item = (id: string, titulo: string) => ({
  identificador: id,
  titulo,
  url_pdf: { texto: `https://www.boe.es/boe/dias/2026/10/30/pdfs/${id}.pdf` },
  url_html: `https://www.boe.es/diario_boe/txt.php?id=${id}`,
});
const SUMARIO = {
  status: { code: '200', text: 'ok' },
  data: {
    sumario: {
      metadatos: { publicacion: 'BOE', fecha_publicacion: '20261030' },
      diario: [
        {
          numero: '270',
          seccion: [
            {
              codigo: '1',
              nombre: 'I. Disposiciones generales',
              departamento: [
                {
                  codigo: '3120',
                  nombre: 'MINISTERIO DE AGRICULTURA, PESCA Y ALIMENTACIÓN',
                  epigrafe: [
                    {
                      nombre: 'Aceite de oliva',
                      item: item(
                        'BOE-A-2026-22717',
                        'Orden APA/1145/2026, de 29 de octubre, por la que se establece la norma de comercialización del aceite de oliva para la campaña 2026/2027.',
                      ),
                    },
                  ],
                },
                {
                  codigo: '6',
                  nombre: 'BANCO DE ESPAÑA',
                  epigrafe: {
                    nombre: 'Entidades financieras',
                    item: item(
                      'BOE-A-2026-22720',
                      'Circular 1/2026, de 21 de octubre, del Banco de España, sobre la Central de Información de Riesgos.',
                    ),
                  },
                },
              ],
            },
            {
              codigo: '2B',
              nombre: 'II. Autoridades y personal. - B. Oposiciones y concursos',
              departamento: {
                codigo: '9',
                nombre: 'ADMINISTRACIÓN LOCAL',
                epigrafe: {
                  nombre: 'Personal funcionario y laboral',
                  item: [
                    item(
                      'BOE-A-2026-22757',
                      'Resolución de 26 de octubre de 2026, del Ayuntamiento de Gijón (Asturias), referente a la convocatoria para proveer varias plazas.',
                    ),
                    item(
                      'BOE-A-2026-22758',
                      'Resolución de 26 de octubre de 2026, del Ayuntamiento de Maracena (Granada), referente a la convocatoria para proveer varias plazas.',
                    ),
                  ],
                },
              },
            },
            {
              codigo: '5A',
              nombre: 'V. Anuncios. - A. Contratación del Sector Público',
              departamento: [
                {
                  codigo: '1',
                  nombre: 'MINISTERIO DE DEFENSA',
                  item: item(
                    'BOE-B-2026-35410',
                    'Anuncio de formalización de contratos de: Instituto de Vivienda, Infraestructura y Equipamiento de la Defensa. Objeto: Obras de reforma.',
                  ),
                },
                { codigo: '2', nombre: 'SIN PUBLICACIONES', texto: 'Nada' },
              ],
            },
          ],
        },
      ],
    },
  },
};

const NOT_FOUND =
  '<?xml version="1.0" encoding="utf-8"?><response><status><code>404</code><text>La información solicitada no existe</text></status><data/></response>';

const fake = (urls: string[]): typeof fetch =>
  (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith('/sumario/20261030')) return new Response(JSON.stringify(SUMARIO));
    return new Response(NOT_FOUND, { status: 404 });
  }) as typeof fetch;

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

// Viernes 30-oct-2026 a las 10:00 en Madrid.
const VIERNES = () => new Date('2026-10-30T09:00:00Z');
const tool = (urls: string[] = [], now = VIERNES) => createBoeTool({ fetchFn: fake(urls), now });

describe('tool boe: «¿ha salido algo en el BOE sobre X?»', () => {
  it('lee el sumario aunque la API mezcle objetos sueltos y listas', () => {
    const items = parseSumario(SUMARIO);
    expect(items.map((i) => i.id)).toEqual([
      'BOE-A-2026-22717',
      'BOE-A-2026-22720',
      'BOE-A-2026-22757',
      'BOE-A-2026-22758',
      'BOE-B-2026-35410',
    ]);
    expect(items[0]?.departamento).toBe('Ministerio de Agricultura, Pesca y Alimentación');
    expect(items[2]?.seccion).toBe('2B');
    expect(parseSumario({ nada: 1 })).toEqual([]);
  });

  it('busca sin mayúsculas, sin tildes y con plurales', () => {
    const [aceite, banco, gijon] = parseSumario(SUMARIO);
    expect(aceite && coincide(aceite, 'Aceite de Oliva')).toBe(true);
    expect(banco && coincide(banco, 'riesgos')).toBe(true);
    expect(gijon && coincide(gijon, 'plazas gijon')).toBe(true);
    expect(gijon && coincide(gijon, 'oposiciones Gijón')).toBe(true);
    expect(gijon && coincide(gijon, 'oposiciones Oviedo')).toBe(false);
    expect(aceite && coincide(aceite, 'algo sobre el aceite')).toBe(true);
    expect(aceite && coincide(aceite, 'de la')).toBe(false);
  });

  it('«¿sale algo hoy en el BOE sobre plazas en Gijón?»', async () => {
    const urls: string[] = [];
    const out = textOf(await tool(urls).execute('t', { buscar: 'plazas Gijón' }));
    expect(out).toBe(
      'En el BOE de hoy, viernes 30 de octubre, hay 1 cosa sobre «plazas Gijón»:\n' +
        '• Resolución de 26 de octubre de 2026, del Ayuntamiento de Gijón (Asturias), referente a la convocatoria para proveer varias plazas. (Administración Local)\n' +
        '  https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-22757',
    );
    expect(urls).toEqual(['https://www.boe.es/datosabiertos/api/boe/sumario/20261030']);
  });

  it('sin coincidencias, otro día y domingo', async () => {
    const t = tool();
    expect(textOf(await t.execute('t', { buscar: 'pesca de bajura' }))).toBe(
      'En el BOE de hoy no ha salido nada sobre «pesca de bajura».',
    );
    expect(sinNovedad('pesca de bajura')).toBe(
      'En el BOE de hoy no ha salido nada sobre «pesca de bajura».',
    );
    const otro = textOf(
      await tool([], () => new Date('2026-11-02T09:00:00Z')).execute('t', {
        buscar: 'aceite',
        fecha: '2026-10-30',
      }),
    );
    expect(otro).toContain('En el BOE del viernes 30 de octubre hay 1 cosa sobre «aceite»:');
    const domingo = textOf(await t.execute('t', { buscar: 'aceite', fecha: '2026-11-01' }));
    expect(domingo).toBe('Los domingos no se publica el BOE.');
    expect(textOf(await t.execute('t', { fecha: '2026-10-31' }))).toBe(
      'El BOE del sábado 31 de octubre aún no ha salido.',
    );
    const madrugada = tool([], () => new Date('2026-10-31T04:00:00Z'));
    const sabado = textOf(await madrugada.execute('t', {}));
    expect(sabado).toBe(
      'Aún no encuentro el BOE del sábado 31 de octubre: puede que no esté publicado todavía.',
    );
    expect(textOf(await t.execute('t', { fecha: '31/10' }))).toContain('AAAA-MM-DD');
  });

  it('«¿qué trae hoy el BOE?»: el resumen del día y las disposiciones generales', async () => {
    const out = textOf(await tool().execute('t', {}));
    expect(out).toContain(
      'El BOE de hoy, viernes 30 de octubre, trae 5 publicaciones: 2 disposiciones generales, 2 oposiciones y concursos y 1 anuncio.',
    );
    expect(out).toContain('Disposiciones generales:\n• Orden APA/1145/2026');
    expect(out).toContain('Todo el sumario: https://www.boe.es/boe/dias/2026/10/30/');
  });

  it('muchas coincidencias: las 8 primeras y el enlace al sumario', async () => {
    const muchos = structuredClone(SUMARIO);
    const sec = muchos.data.sumario.diario[0]?.seccion[1] as {
      departamento: { epigrafe: { item: unknown[] } };
    };
    for (let i = 0; i < 10; i += 1)
      sec.departamento.epigrafe.item.push(
        item(`BOE-A-2026-3000${i}`, `Resolución ${i} sobre provisión de plazas.`),
      );
    const f = (async () => new Response(JSON.stringify(muchos))) as unknown as typeof fetch;
    const out = textOf(
      await createBoeTool({ fetchFn: f, now: VIERNES }).execute('t', { buscar: 'plazas' }),
    );
    expect(out).toContain('hay 12 cosas sobre «plazas»');
    expect((out.match(/^• /gm) ?? []).length).toBe(8);
    expect(out).toContain('Y 4 más en el sumario: https://www.boe.es/boe/dias/2026/10/30/');
  });

  it('BOE caído, sin red o lento: mensaje amable sin el error crudo', async () => {
    const off = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const a = textOf(await createBoeTool({ fetchFn: off, now: VIERNES }).execute('t', {}));
    expect(a).toBe('No pude consultar el BOE ahora mismo. Prueba otra vez en un rato.');
    const down = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    const b = textOf(await createBoeTool({ fetchFn: down, now: VIERNES }).execute('t', {}));
    expect(b).not.toMatch(/503|HTTP/);
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch;
    const c = textOf(
      await createBoeTool({ fetchFn: hang, now: VIERNES, timeoutMs: 20 }).execute('t', {}),
    );
    expect(c).toContain('No pude consultar el BOE');
  });

  it('caché: dos preguntas del mismo día, una llamada', async () => {
    const urls: string[] = [];
    const t = tool(urls);
    await t.execute('t', { buscar: 'aceite' });
    await t.execute('t', { buscar: 'riesgos' });
    expect(urls).toHaveLength(1);
  });

  it('el aviso: pide el tema, crea la rutina «solo si sale algo», lista y se quita', async () => {
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
        [...routines.keys()]
          .map((k) => k.split('|'))
          .filter(([s]) => !scope || s === scope)
          .map(([s, name]) => ({ scope: s, name })) as never,
    };
    const settings: unknown[] = [];
    const commits: [string, string][] = [];
    let syncs = 0;
    const t = createBoeTool({
      fetchFn: fake([]),
      now: VIERNES,
      store,
      scopeOf: () => 'chat1',
      sync: () => {
        syncs += 1;
      },
      delivery: {
        set: (_s, name, setting) => settings.push([name, setting]),
        commit: (_s, name, hash) => commits.push([name, hash]),
      },
    });
    expect(textOf(await t.execute('t', { aviso: 'activar' }))).toContain('¿Sobre qué');
    const on = textOf(await t.execute('t', { aviso: 'activar', buscar: '  Ayudas   Vivienda ' }));
    expect(on).toBe(
      'Hecho: de lunes a sábado a las 9:00 miro el BOE y solo te escribo si sale algo sobre «ayudas vivienda». Para quitarlo, dime «quita el aviso del BOE».',
    );
    const name = avisoRoutineName('ayudas vivienda');
    expect(name).toBe('aviso boe: ayudas vivienda');
    const r = routines.get(`chat1|${name}`);
    expect(r?.schedule).toBe(AVISO_SCHEDULE);
    expect(AVISO_SCHEDULE).toBe('0 9 * * 1-6');
    expect(r?.prompt).toContain('buscar «ayudas vivienda» y rutina true');
    expect(settings).toEqual([[name, { target: 'chat', soloSiCambia: true }]]);
    expect(commits).toEqual([[name, outputHash(sinNovedad('ayudas vivienda'))]]);
    expect(syncs).toBe(1);

    // La rutina, un día sin nada: deja «nada» como lo último dicho y devuelve ese texto,
    // así no repite «no ha salido nada» el día después de un aviso.
    commits.length = 0;
    const nada = textOf(await t.execute('t', { buscar: 'ayudas vivienda', rutina: true }));
    expect(nada).toBe(sinNovedad('ayudas vivienda'));
    expect(commits).toEqual([[name, outputHash(nada)]]);
    commits.length = 0;
    const algo = textOf(await t.execute('t', { buscar: 'vivienda', rutina: true }));
    expect(algo).toContain('hay 1 cosa sobre «vivienda»');
    expect(commits).toEqual([]);

    await t.execute('t', { aviso: 'activar', buscar: 'aceite' });
    const ver = textOf(await t.execute('t', { aviso: 'ver' }));
    expect(ver).toBe(
      'Vigilo el BOE (de lunes a sábado a las 9:00) sobre: «ayudas vivienda» y «aceite».',
    );
    expect(textOf(await t.execute('t', { aviso: 'desactivar', buscar: 'Aceite' }))).toBe(
      'Hecho: ya no vigilo el BOE sobre «aceite».',
    );
    expect(textOf(await t.execute('t', { aviso: 'desactivar' }))).toBe(
      'Hecho: ya no vigilo el BOE sobre «ayudas vivienda».',
    );
    expect(routines.size).toBe(0);
    expect(textOf(await t.execute('t', { aviso: 'desactivar' }))).toBe(
      'No tenías ningún aviso del BOE.',
    );
    expect(textOf(await t.execute('t', { aviso: 'ver' }))).toBe('No tienes ningún aviso del BOE.');
  });

  it('la puerta: consultar es lectura; encender o quitar el aviso escribe local', () => {
    const gate = new Gate({ approver: () => true });
    const kind = (args: Record<string, unknown>) =>
      gate.classifyEffect({ tool: 'boe', args, actor: 'test' });
    expect(kind({ buscar: 'aceite' })).toBe('lee');
    expect(kind({ buscar: 'aceite', rutina: true })).toBe('lee');
    expect(kind({ aviso: 'ver' })).toBe('lee');
    expect(kind({ aviso: 'activar', buscar: 'aceite' })).toBe('escribe-local');
    expect(kind({ aviso: 'desactivar' })).toBe('escribe-local');
  });
});

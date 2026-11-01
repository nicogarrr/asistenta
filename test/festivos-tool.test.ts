import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import {
  comunidadFromEnv,
  createFestivosTool,
  festivosLocalesFromEnv,
  parseNager,
} from '../src/tools/festivos.js';

// Festivos de 2026 tal como los devuelve date.nager.at (nacionales + Asturias y Madrid).
const Y2026 = [
  { date: '2026-01-01', localName: 'Año Nuevo', global: true, counties: null },
  {
    date: '2026-01-06',
    localName: 'Día de Reyes / Epifanía del Señor',
    global: true,
    counties: null,
  },
  {
    date: '2026-04-02',
    localName: 'Jueves Santo',
    global: false,
    counties: [
      'ES-AN',
      'ES-AR',
      'ES-CL',
      'ES-CM',
      'ES-CN',
      'ES-EX',
      'ES-GA',
      'ES-IB',
      'ES-RI',
      'ES-MD',
      'ES-MC',
      'ES-NC',
      'ES-AS',
      'ES-PV',
      'ES-CB',
    ],
  },
  { date: '2026-04-03', localName: 'Viernes Santo', global: true, counties: null },
  { date: '2026-05-01', localName: 'Fiesta del trabajo', global: true, counties: null },
  {
    date: '2026-05-02',
    localName: 'Fiesta de la Comunidad de Madrid',
    global: false,
    counties: ['ES-MD'],
  },
  { date: '2026-08-15', localName: 'Asunción', global: true, counties: null },
  { date: '2026-09-08', localName: 'Día de Asturias', global: false, counties: ['ES-AS'] },
  { date: '2026-10-12', localName: 'Fiesta Nacional de España', global: true, counties: null },
  { date: '2026-11-01', localName: 'Día de todos los Santos', global: true, counties: null },
  { date: '2026-12-06', localName: 'Día de la Constitución', global: true, counties: null },
  { date: '2026-12-08', localName: 'Inmaculada Concepción', global: true, counties: null },
  { date: '2026-12-25', localName: 'Navidad', global: true, counties: null },
];
const Y2027 = [
  { date: '2027-01-01', localName: 'Año Nuevo', global: true, counties: null },
  {
    date: '2027-01-06',
    localName: 'Día de Reyes / Epifanía del Señor',
    global: true,
    counties: null,
  },
];

const fake = (urls: string[]): typeof fetch =>
  (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    const body = u.includes('/2026/') ? Y2026 : u.includes('/2027/') ? Y2027 : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

// Domingo 1-nov-2026, 10:00 en Madrid.
const nov1 = () => new Date('2026-11-01T09:00:00Z');
const tool = (env: NodeJS.ProcessEnv = {}, urls: string[] = []) =>
  createFestivosTool({ fetchFn: fake(urls), now: nov1, env });

describe('tool festivos: «¿el lunes es festivo?»', () => {
  it('comunidad: Asturias por defecto, se cambia con PA_FESTIVOS_COMUNIDAD', () => {
    expect(comunidadFromEnv({})).toBe('ES-AS');
    expect(comunidadFromEnv({ PA_FESTIVOS_COMUNIDAD: 'md' })).toBe('ES-MD');
    expect(comunidadFromEnv({ PA_FESTIVOS_COMUNIDAD: 'ES-CT' })).toBe('ES-CT');
    expect(comunidadFromEnv({ PA_FESTIVOS_COMUNIDAD: 'Marte' })).toBeNull();
  });

  it('separa nacionales de los de la comunidad', () => {
    const as = parseNager(Y2026, 'ES-AS').map((f) => `${f.date} ${f.where}`);
    expect(as).toContain('2026-09-08 comunidad');
    expect(as).toContain('2026-10-12 nacional');
    expect(as).not.toContain('2026-05-02 comunidad');
    expect(parseNager({ nope: 1 }, 'ES-AS')).toEqual([]);
  });

  it('un día festivo de la comunidad: sí, con el nombre', async () => {
    const urls: string[] = [];
    const out = textOf(await tool({}, urls).execute('t', { fecha: '2026-09-08' }));
    expect(out).toContain(
      'Sí: el martes 8 de septiembre es festivo (Día de Asturias, en Asturias)',
    );
    expect(out).toContain('puente si coges el lunes 7 de septiembre');
    expect(new URL(urls[0] ?? '').host).toBe('date.nager.at');
  });

  it('un lunes normal: no, y cuál es el siguiente', async () => {
    const out = textOf(await tool().execute('t', { fecha: '2026-11-09' }));
    expect(out).toContain('No: el lunes 9 de noviembre no es festivo en Asturias.');
    expect(out).toContain(
      'El siguiente es el domingo 6 de diciembre (Día de la Constitución, nacional)',
    );
  });

  it('en Madrid el 2 de mayo sí; en Asturias no', async () => {
    const md = textOf(
      await tool({ PA_FESTIVOS_COMUNIDAD: 'ES-MD' }).execute('t', { fecha: '2026-05-02' }),
    );
    expect(md).toContain('Sí');
    expect(md).toContain('en Madrid');
    const as = textOf(await tool().execute('t', { fecha: '2026-05-02' }));
    expect(as).toContain('No: el sábado 2 de mayo no es festivo en Asturias. Es fin de semana');
  });

  it('las fiestas locales y los traslados se añaden con PA_FESTIVOS_LOCALES', async () => {
    expect(
      festivosLocalesFromEnv({
        PA_FESTIVOS_LOCALES: '06-29=San Pedro, 2026-11-02=Todos los Santos (traslado), basura',
      }),
    ).toEqual([
      { when: '06-29', name: 'San Pedro' },
      { when: '2026-11-02', name: 'Todos los Santos (traslado)' },
    ]);
    const env = { PA_FESTIVOS_LOCALES: '2026-11-02=Todos los Santos (traslado)' };
    const out = textOf(await tool(env).execute('t', { fecha: '2026-11-02' }));
    expect(out).toContain(
      'Sí: el lunes 2 de noviembre es festivo (Todos los Santos (traslado), local)',
    );
  });

  it('sin fecha: los próximos festivos, cruzando el año', async () => {
    const urls: string[] = [];
    const out = textOf(await tool({}, urls).execute('t', {}));
    expect(out).toContain('Próximos festivos en Asturias:');
    // 1-nov es hoy y cae en domingo: sale, sin nota de puente.
    expect(out).toContain('• domingo 1 de noviembre: Día de todos los Santos, nacional\n');
    expect(out).toContain(
      '• martes 8 de diciembre: Inmaculada Concepción, nacional (puente si coges el lunes 7 de diciembre)',
    );
    expect(out).toContain(
      'viernes 1 de enero: Año Nuevo, nacional (fin de semana largo: 3 días, del viernes 1 de enero al domingo 3 de enero)',
    );
    expect(urls.map((u) => u.split('/').slice(-2)[0])).toEqual(['2026', '2027']);
  });

  it('puentes: solo los que lo son', async () => {
    const out = textOf(await tool().execute('t', { puentes: true }));
    expect(out).toContain('Puentes y findes largos en Asturias:');
    expect(out).toContain('martes 8 de diciembre');
    expect(out).not.toContain('domingo 6 de diciembre');
    expect(out).not.toContain('viernes 25 de diciembre: Navidad, nacional\n');
    expect(out).toContain('viernes 25 de diciembre: Navidad, nacional (fin de semana largo');
  });

  it('servicio caído, sin red o lento: mensaje amable sin el error crudo', async () => {
    const off = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const a = textOf(
      await createFestivosTool({ fetchFn: off, now: nov1, env: {} }).execute('t', {}),
    );
    expect(a).toContain('No pude consultar los festivos');
    expect(a).not.toContain('fetch failed');
    const down = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const b = textOf(
      await createFestivosTool({ fetchFn: down, now: nov1, env: {} }).execute('t', {}),
    );
    expect(b).toContain('No pude consultar los festivos');
    expect(b).not.toMatch(/500|HTTP/);
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch;
    const c = textOf(
      await createFestivosTool({ fetchFn: hang, now: nov1, env: {}, timeoutMs: 20 }).execute(
        't',
        {},
      ),
    );
    expect(c).toContain('No pude consultar los festivos');
  });

  it('una comunidad desconocida avisa y cuenta solo los nacionales', async () => {
    const out = textOf(
      await tool({ PA_FESTIVOS_COMUNIDAD: 'Marte' }).execute('t', { fecha: '2026-09-08' }),
    );
    expect(out).toContain('No: el martes 8 de septiembre no es festivo.');
    expect(out).toContain('No reconozco la comunidad');
  });

  it('caché: dos preguntas del mismo año, una llamada por año', async () => {
    const urls: string[] = [];
    const t = tool({}, urls);
    await t.execute('t', { fecha: '2026-11-09' });
    await t.execute('t', { puentes: true });
    expect(urls).toHaveLength(2);
  });

  it('la puerta la trata como lectura', () => {
    const gate = new Gate({ approver: () => true });
    expect(
      gate.classifyEffect({ tool: 'festivos', args: { fecha: '2026-11-09' }, actor: 'test' }),
    ).toBe('lee');
  });
});

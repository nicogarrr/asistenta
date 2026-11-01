import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';
import { createTraficoTool, normCarretera, parseIncidencias } from '../src/tools/trafico.js';

// Feed DATEX II de la DGT (1-nov-2026, 10:47), recortado: 9 incidencias de Asturias, un
// accidente en A Coruña y un vehículo detenido en la A-8 en Cantabria.
const XML = readFileSync(new URL('./fixtures/dgt-trafico.xml', import.meta.url), 'utf8');
const NOW = () => new Date('2026-11-01T09:50:00Z'); // domingo 1-nov, 10:50 en Madrid

const fake = (urls: string[]): typeof fetch =>
  (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(XML, { status: 200, headers: { 'content-type': 'text/xml' } });
  }) as typeof fetch;

const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

const tool = (env: NodeJS.ProcessEnv = {}, urls: string[] = []) =>
  createTraficoTool({ fetchFn: fake(urls), env, now: NOW });

describe('tool trafico: «¿cómo está el tráfico?» con la DGT', () => {
  it('lee las incidencias del XML de la DGT', () => {
    const all = parseIncidencias(XML);
    expect(all).toHaveLength(11);
    const gijon = all.find((i) => i.municipio === 'Gijón');
    expect(gijon).toMatchObject({
      carretera: 'A-8',
      provincia: 'Asturias',
      km: [390.8, 392.5],
      que: 'laneClosures',
      causa: 'roadworks',
    });
    expect(gijon?.fin?.toISOString()).toBe('2026-12-18T05:00:00.000Z');
    expect(parseIncidencias('<html>caído</html>')).toEqual([]);
    expect(normCarretera(' a8 ')).toBe('A8');
    expect(normCarretera('AS-17')).toBe('AS17');
  });

  it('por defecto, Asturias: lo urgente primero y sin repetir los dos sentidos', async () => {
    const urls: string[] = [];
    const out = textOf(await tool({}, urls).execute('t', {}));
    expect(out).toBe(
      [
        'Tráfico ahora en Asturias (DGT, 10:47): 7 incidencias.',
        '• A-8, km 398,2 (Carreño): vehículo detenido, desde las 10:40.',
        '• A-8, km 401,9 (Corvera de Asturias): vehículo detenido, desde las 10:33.',
        '• AS-15, km 24 a 28 (Tinéu): tráfico lento por desprendimientos, desde el 25 de julio.',
        '• MO-1, km 4,55 a 4,58 (Morcín): calzada cortada por obras, hasta el 3 de noviembre.',
        '• A-8, km 503,9 a 504,2 (Castropol), sentido Cantabria: firme en mal estado, desde el 20 de octubre.',
        '• A-8, km 390,8 a 392,5 (Gijón): carril cortado por obras, hasta el 18 de diciembre.',
        '• AS-12, km 54 (Pesoz): paso alternativo por desprendimientos, desde el 20 de febrero.',
      ].join('\n'),
    );
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0] ?? '').host).toBe('nap.dgt.es');
  });

  it('una carretera: en toda España, con la provincia', async () => {
    const out = textOf(await tool().execute('t', { carretera: 'a8' }));
    expect(out).toContain('Tráfico ahora en la A-8 (DGT, 10:47): 5 incidencias.');
    expect(out).toContain(
      '• A-8, km 243,3 (Cabezón de la Sal, Cantabria): vehículo detenido, desde las 10:22.',
    );
    expect(out).not.toContain('AS-12');
    const una = textOf(await tool().execute('t', { carretera: 'A-8', provincia: 'cantabria' }));
    expect(una).toContain('Tráfico ahora en la A-8 en Cantabria (DGT, 10:47): 1 incidencia.');
    const nada = textOf(await tool().execute('t', { carretera: 'N-634' }));
    expect(nada).toBe('Ahora mismo la DGT no tiene ninguna incidencia en la N-634.');
  });

  it('otra provincia: PA_TRAFICO_PROVINCIA o la que pida (sin tildes también)', async () => {
    const a = textOf(await tool({ PA_TRAFICO_PROVINCIA: 'Cantabria' }).execute('t', {}));
    expect(a).toContain('Tráfico ahora en Cantabria (DGT, 10:47): 1 incidencia.');
    const b = textOf(await tool().execute('t', { provincia: 'a coruna' }));
    expect(b).toContain(
      '• CG-1.5, km 17 a 17,2 (Rois), sentido Noia: carril cortado por accidente, desde el 25 de mayo.',
    );
    const c = textOf(await tool().execute('t', { provincia: 'Soria' }));
    expect(c).toBe('Ahora mismo la DGT no tiene ninguna incidencia en Soria.');
  });

  it('muchas incidencias: las 10 primeras y cuántas faltan', async () => {
    const one = XML.match(/<sit:situation\b[\s\S]*?<\/sit:situation>/)?.[0] ?? '';
    const many = Array.from({ length: 14 }, (_, i) =>
      one.replaceAll('<lse:kilometerPoint>54.0<', `<lse:kilometerPoint>${60 + i}.0<`),
    ).join('\n');
    const xml = XML.replace('</d2:payload>', `${many}\n</d2:payload>`);
    const f = (async () => new Response(xml)) as unknown as typeof fetch;
    const out = textOf(await createTraficoTool({ fetchFn: f, env: {}, now: NOW }).execute('t', {}));
    expect(out).toContain('21 incidencias');
    expect((out.match(/^• /gm) ?? []).length).toBe(10);
    expect(out).toContain('Y 11 más.');
  });

  it('un tramo con varias medidas por las mismas obras se dice una vez, lo más serio', async () => {
    const gijon =
      XML.match(
        /<sit:situation\b(?:(?!<\/sit:situation>)[\s\S])*?Gijón[\s\S]*?<\/sit:situation>/,
      )?.[0] ?? '';
    expect(gijon).toContain('laneClosures');
    const cortada = gijon
      .replace('laneClosures', 'carriagewayClosures')
      .replace(
        '<loc:roadInformation>',
        '<loc:roadInformation><loc:roadDestination>AMBOS SENTIDO GIJON Y SEVILLA</loc:roadDestination>',
      );
    const xml = XML.replace('</d2:payload>', `${cortada}\n</d2:payload>`);
    const f = (async () => new Response(xml)) as unknown as typeof fetch;
    const out = textOf(await createTraficoTool({ fetchFn: f, env: {}, now: NOW }).execute('t', {}));
    expect(out).toContain('7 incidencias');
    expect(out).toContain(
      '• A-8, km 390,8 a 392,5 (Gijón): calzada cortada por obras, hasta el 18 de diciembre.',
    );
    expect(out).not.toContain('carril cortado por obras');
    expect(out).not.toContain('Ambos');
  });

  it('DGT caída, sin red o lenta: mensaje amable sin el error crudo', async () => {
    const off = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const msg = 'No pude consultar el tráfico de la DGT ahora mismo. Prueba otra vez en un rato.';
    expect(textOf(await createTraficoTool({ fetchFn: off, env: {} }).execute('t', {}))).toBe(msg);
    const down = (async () => new Response('', { status: 502 })) as unknown as typeof fetch;
    expect(textOf(await createTraficoTool({ fetchFn: down, env: {} }).execute('t', {}))).toBe(msg);
    const html = (async () =>
      new Response('<html>mantenimiento</html>')) as unknown as typeof fetch;
    expect(textOf(await createTraficoTool({ fetchFn: html, env: {} }).execute('t', {}))).toBe(msg);
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch;
    expect(
      textOf(await createTraficoTool({ fetchFn: hang, env: {}, timeoutMs: 20 }).execute('t', {})),
    ).toBe(msg);
  });

  it('caché de 5 minutos: dos preguntas, una llamada', async () => {
    const urls: string[] = [];
    const t = tool({}, urls);
    await t.execute('t', {});
    await t.execute('t', { carretera: 'A-8' });
    expect(urls).toHaveLength(1);
  });

  it('la puerta: siempre lectura', () => {
    const gate = new Gate({ approver: () => true });
    expect(
      gate.classifyEffect({ tool: 'trafico', args: { carretera: 'A-8' }, actor: 'test' }),
    ).toBe('lee');
  });
});

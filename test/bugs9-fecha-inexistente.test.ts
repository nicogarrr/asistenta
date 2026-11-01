import { describe, expect, it } from 'vitest';
import { createBoeTool } from '../src/tools/boe.js';
import { createFestivosTool } from '../src/tools/festivos.js';

// asis-bugs-9: «¿el 30 de febrero es festivo?» llegaba como 2026-02-30 y la respuesta era
// sobre otro día («No: el lunes 2 de marzo no es festivo»); «2026-13-01» rompía la
// herramienta con «RangeError: Invalid time value». En el BOE, 2026-02-30 se leía como el 2 de
// marzo. Una fecha que no existe se dice, no se cambia por otra.
const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');
const urls: string[] = [];
const fake = (async (u: string | URL | Request) => {
  urls.push(String(u));
  return new Response('[]', { status: 200 });
}) as unknown as typeof fetch;
const now = () => new Date('2026-11-01T09:00:00Z');

describe('una fecha que no existe', () => {
  it('festivos: 30 de febrero y mes 13', async () => {
    const t = createFestivosTool({ fetchFn: fake, now, env: {} });
    const feb = textOf(await t.execute('t', { fecha: '2026-02-30' }));
    expect(feb).toBe('Esa fecha no existe (2026-02-30). Dime el día como AAAA-MM-DD.');
    expect(feb).not.toContain('marzo');
    const m13 = textOf(await t.execute('t', { fecha: '2026-13-01' }));
    expect(m13).toBe('Esa fecha no existe (2026-13-01). Dime el día como AAAA-MM-DD.');
    // Las de verdad siguen igual (29 de febrero de un año bisiesto incluido).
    expect(textOf(await t.execute('t', { fecha: '2028-02-29' }))).toContain(
      'No: el martes 29 de febrero',
    );
  });

  it('BOE: 31 de abril no es el 1 de mayo, y no se consulta nada', async () => {
    urls.length = 0;
    const out = textOf(
      await createBoeTool({ fetchFn: fake, now }).execute('t', { fecha: '2026-04-31' }),
    );
    expect(out).toBe('Esa fecha no existe (2026-04-31). Dime el día como AAAA-MM-DD.');
    expect(urls).toHaveLength(0);
  });
});

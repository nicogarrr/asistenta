import { describe, expect, it } from 'vitest';
import { createFestivosTool } from '../src/tools/festivos.js';

// asis-bugs-9: dos festivos seguidos (jueves y viernes santo) salían como dos puentes, cada uno
// con la misma línea «fin de semana largo: 4 días…». Es un solo finde largo: una línea.
const Y2026 = [
  { date: '2026-04-02', localName: 'Jueves Santo', global: false, counties: ['ES-AS'] },
  { date: '2026-04-03', localName: 'Viernes Santo', global: true, counties: null },
  { date: '2026-05-01', localName: 'Fiesta del trabajo', global: true, counties: null },
  { date: '2026-12-07', localName: 'Traslado Constitución', global: false, counties: ['ES-AS'] },
  { date: '2026-12-08', localName: 'Inmaculada Concepción', global: true, counties: null },
];
const fake = (async (url: string | URL | Request) =>
  new Response(JSON.stringify(String(url).includes('/2026/') ? Y2026 : []), {
    status: 200,
  })) as typeof fetch;
const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

describe('festivos: puentes con dos festivos seguidos', () => {
  it('jueves y viernes santo: un solo finde largo, con los dos nombres', async () => {
    const tool = createFestivosTool({
      fetchFn: fake,
      now: () => new Date('2026-03-01T09:00:00Z'),
      env: {},
    });
    const out = textOf(await tool.execute('t', { puentes: true }));
    expect(out.match(/fin de semana largo: 4 días, del jueves 2 de abril/g)).toHaveLength(1);
    expect(out).toContain(
      '• jueves 2 de abril: Jueves Santo, en Asturias; viernes 3 de abril: Viernes Santo, nacional (fin de semana largo: 4 días, del jueves 2 de abril al domingo 5 de abril)',
    );
    // lunes y martes: también uno solo.
    expect(out.match(/del sábado 5 de diciembre al martes 8 de diciembre/g)).toHaveLength(1);
    expect(out).toContain('viernes 1 de mayo: Fiesta del trabajo, nacional (fin de semana largo');
  });
});

/**
 * «¿Cuánto he gastado este mes?» / «hazme una gráfica de mis gastos»: el Ojo de águila ya
 * apuntaba los cobros de los correos (vigilante_charges) pero solo para avisar de cargos
 * raros; el modelo no tenía de dónde sacar «mis gastos». Ahora el tool `gastos` los da por
 * mes, por comercio o uno a uno, solo al dueño en su chat privado y diciendo que es una
 * lectura del correo, no del banco.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { initChargeStore } from '../src/ojo-charges.js';
import { Gate } from '../src/permissions.js';
import { createGastosTool, euros, gastosTexto, mesDe, ultimosMeses } from '../src/tools/gastos.js';

const TZ = 'Europe/Madrid';
const NOW = Date.UTC(2026, 10, 5, 9, 0); // 5 nov 2026
const day = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d, 12);
const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  initChargeStore(d);
  const ins = d.prepare(
    "INSERT INTO vigilante_charges (msg_id, sender, cents, at, status, created_at) VALUES (?, ?, ?, ?, 'ok', ?)",
  );
  const rows: Array<[string, number, number]> = [
    ['amazon.es', 3999, day(2026, 11, 2)],
    ['email.amazon.es', 1250, day(2026, 10, 20)],
    ['iberdrola.es', 5810, day(2026, 10, 3)],
    ['netflix.com', 1399, day(2026, 9, 15)],
    ['netflix.com', 1399, day(2026, 3, 15)], // fuera de los 6 meses
  ];
  for (const [i, [s, c, at]] of rows.entries()) ins.run(`m${i}`, s, c, at, at);
  return d;
}

describe('tool gastos', () => {
  it('por mes: los últimos 6 meses con total y nota de que es del correo', async () => {
    const tool = createGastosTool({
      db: db(),
      allowed: () => true,
      now: () => NOW,
      timeZone: () => TZ,
    });
    const t = textOf(await tool.execute('1', {}));
    expect(t).toContain(
      'Gastos de los últimos 6 meses (jun 2026 – nov 2026): 124,58 € en 4 cobros.',
    );
    expect(t).toContain('nov 2026: 39,99 € (1 cobro)');
    expect(t).toContain('oct 2026: 70,60 € (2 cobros)');
    expect(t).toContain('jul 2026: 0,00 € (0 cobros)');
    expect(t).toContain('no del banco');
    expect(t).toContain('entregable');
  });

  it('por comercio junta subdominios; lista uno a uno', async () => {
    const tool = createGastosTool({
      db: db(),
      allowed: () => true,
      now: () => NOW,
      timeZone: () => TZ,
    });
    const c = textOf(await tool.execute('1', { agrupar: 'comercio', meses: 3 }));
    expect(c).toContain('iberdrola.es: 58,10 € (1 cobro)');
    expect(c).toContain('amazon.es: 52,49 € (2 cobros)');
    expect(c.indexOf('iberdrola.es')).toBeLessThan(c.indexOf('amazon.es'));
    const l = textOf(await tool.execute('2', { agrupar: 'lista', meses: 1 }));
    expect(l).toMatch(/0?2\/11 · amazon\.es · 39,99 €/);
    expect(l).toContain('Gastos de nov 2026: 39,99 € en 1 cobro.');
  });

  it('fuera del chat del dueño no enseña nada; sin cobros explica de dónde salen', async () => {
    expect(
      textOf(
        await createGastosTool({ db: db(), allowed: () => false, now: () => NOW }).execute('1', {}),
      ),
    ).toMatch(/solo se consultan/);
    const vacio = new DatabaseSync(':memory:');
    const t = textOf(
      await createGastosTool({
        db: vacio,
        allowed: () => true,
        now: () => NOW,
        timeZone: () => TZ,
      }).execute('1', { meses: 1 }),
    );
    expect(t).toContain('No tengo cobros apuntados en este mes');
    expect(t).toContain('/ojo');
  });

  it('meses en la zona del dueño', () => {
    expect(euros(123456)).toBe('1.234,56 €');
    // 31 oct 23:30 UTC = 1 nov 00:30 en Madrid.
    expect(mesDe(Date.UTC(2026, 9, 31, 23, 30), TZ)).toBe('2026-11');
    expect(ultimosMeses(NOW, 3, TZ)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(ultimosMeses(Date.UTC(2026, 0, 10), 2, TZ)).toEqual(['2025-12', '2026-01']);
    expect(gastosTexto([], { now: NOW, meses: 6, agrupar: 'mes', timeZone: TZ })).toContain(
      'últimos 6 meses',
    );
  });

  it('la Gate lo trata como lectura', () => {
    expect(new Gate().classifyEffect({ tool: 'gastos', args: {}, actor: 'test' })).toBe('lee');
  });
});

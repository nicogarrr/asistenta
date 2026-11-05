import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { initChargeStore } from '../src/ojo-charges.js';
import { PaginasVivas } from '../src/paginas-vivas.js';
import { Gate } from '../src/permissions.js';
import {
  type Cobro,
  createGastosTool,
  GASTOS_PAGINA_ORIGEN,
  gastosPaginaTexto,
  refrescarPaginaGastos,
} from '../src/tools/gastos.js';

const TZ = 'Europe/Madrid';
const NOW = Date.UTC(2026, 10, 5, 11, 0); // 5 nov 2026, 12:00 Madrid
const DIA = 86_400_000;

const cobros: Cobro[] = [
  { sender: 'email.amazon.es', cents: 2599, at: NOW - 1 * DIA },
  { sender: 'amazon.es', cents: 1000, at: NOW - 2 * DIA },
  { sender: 'netflix.com', cents: 1299, at: NOW - 3 * DIA },
  { sender: 'iberdrola.es', cents: 6450, at: Date.UTC(2026, 9, 10, 9, 0) }, // octubre
];

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  initChargeStore(d);
  const ins = d.prepare(
    "INSERT INTO vigilante_charges (msg_id, sender, cents, at, status, reason, median_cents, n_prior, created_at, subject_key) VALUES (?, ?, ?, ?, 'base', NULL, NULL, 0, ?, NULL)",
  );
  cobros.forEach((c, i) => {
    ins.run(`m${i}`, c.sender, c.cents, c.at, NOW);
  });
  return d;
}

describe('«Mis gastos»: página del panel que se rehace sola', () => {
  it('el texto de la página: este mes, por meses, por comercio y de dónde salen los datos', () => {
    const t = gastosPaginaTexto(cobros, { now: NOW, timeZone: TZ });
    expect(t).toContain('# Mis gastos');
    expect(t).toContain('Este mes (nov 2026): 48,98 € en 3 cobros');
    expect(t).toContain('| oct 2026 | 64,50 € | 1 |');
    expect(t).toContain('| nov 2026 | 48,98 € | 3 |');
    expect(t).toContain('| amazon.es | 35,99 € | 2 |');
    expect(t).toContain('no del banco');
    // Sin la hora de ahora: abrir el panel no la reescribe si no hay cobros nuevos.
    expect(gastosPaginaTexto(cobros, { now: NOW + 3_600_000, timeZone: TZ })).toBe(t);
  });

  it('sin cobros dice cómo tenerlos (Ojo de águila)', () => {
    expect(gastosPaginaTexto([], { now: NOW, timeZone: TZ })).toContain('/ojo');
  });

  it('la herramienta con pagina=true crea «Mis gastos» en Páginas', async () => {
    const d = db();
    const paginas = new PaginasVivas(d);
    const tool = createGastosTool({
      db: d,
      allowed: () => true,
      now: () => NOW,
      timeZone: () => TZ,
      paginas,
    });
    const r = await tool.execute('1', { pagina: true });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain('Páginas');
    const p = paginas.ver('Mis gastos');
    expect(p?.origen).toBe(GASTOS_PAGINA_ORIGEN);
    expect(p?.contenido).toContain('48,98 €');
  });

  it('refrescar: solo la página automática, y solo si cambió', () => {
    const d = db();
    const paginas = new PaginasVivas(d);
    // Sin página: no crea nada.
    expect(refrescarPaginaGastos(d, paginas, NOW, TZ)).toBe(false);
    expect(paginas.ver('Mis gastos')).toBeNull();
    // Una «Mis gastos» hecha a mano (otro origen) no se toca.
    paginas.guardar('Mis gastos', 'mi tabla a mano', 'chat', NOW);
    expect(refrescarPaginaGastos(d, paginas, NOW, TZ)).toBe(false);
    expect(paginas.ver('Mis gastos')?.contenido).toBe('mi tabla a mano');
    // La automática se rehace con un cobro nuevo y no se reescribe si nada cambió.
    paginas.guardar(
      'Mis gastos',
      gastosPaginaTexto(cobros, { now: NOW, timeZone: TZ }),
      GASTOS_PAGINA_ORIGEN,
      NOW,
    );
    expect(refrescarPaginaGastos(d, paginas, NOW + 1000, TZ)).toBe(false);
    d.prepare(
      "INSERT INTO vigilante_charges (msg_id, sender, cents, at, status, reason, median_cents, n_prior, created_at, subject_key) VALUES ('nuevo', 'spotify.com', 1099, ?, 'base', NULL, NULL, 0, ?, NULL)",
    ).run(NOW - 60_000, NOW);
    expect(refrescarPaginaGastos(d, paginas, NOW + 2000, TZ)).toBe(true);
    expect(paginas.ver('Mis gastos')?.contenido).toContain('spotify.com');
  });

  it('fuera del chat privado del dueño no crea la página', async () => {
    const d = db();
    const paginas = new PaginasVivas(d);
    const tool = createGastosTool({ db: d, allowed: () => false, now: () => NOW, paginas });
    await tool.execute('1', { pagina: true });
    expect(paginas.ver('Mis gastos')).toBeNull();
  });

  it('la puerta: consultar es lectura; crear la página, escritura local', () => {
    const gate = new Gate({ approver: () => true });
    expect(gate.classifyEffect({ tool: 'gastos', args: {}, actor: 'test' })).toBe('lee');
    expect(gate.classifyEffect({ tool: 'gastos', args: { pagina: true }, actor: 'test' })).toBe(
      'escribe-local',
    );
  });
});

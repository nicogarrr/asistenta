import type { DatabaseSync } from 'node:sqlite';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { localTimeZone } from '../datecontext.js';
import { initChargeStore, registrableDomain } from '../ojo-charges.js';

/**
 * «¿Cuánto he gastado este mes?», «mis gastos por mes», «¿en qué gasto más?»: los cobros que
 * el Ojo de águila ya apunta al leer los correos de cobro (tabla `vigilante_charges`). Antes
 * esos datos solo servían para avisar de un cargo raro; el modelo no podía consultarlos, así
 * que «hazme una gráfica de mis gastos» no tenía de dónde sacar números. Solo lectura y solo
 * en el chat privado del dueño. Es una lectura del correo, no del banco: se dice siempre.
 */

const Params = lazySchema(() =>
  Type.Object({
    agrupar: Type.Optional(
      Type.Union([Type.Literal('mes'), Type.Literal('comercio'), Type.Literal('lista')], {
        description:
          'mes = total por mes (por defecto); comercio = total por remitente; lista = cada cobro.',
      }),
    ),
    meses: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 24,
        description: 'Cuántos meses hacia atrás, contando el actual (por defecto 6).',
      }),
    ),
  }),
);

export interface Cobro {
  sender: string;
  cents: number;
  at: number;
}

const EUR = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 123456 → «1.234,56 €» (es-ES no agrupa 4 cifras; para importes se lee mejor con el punto). */
export const euros = (cents: number): string => {
  const s = EUR.format(cents / 100);
  return `${/^-?\d{4},/.test(s) ? s.replace(/^(-?\d)(\d{3})/, '$1.$2') : s} €`;
};

/** «2026-11» del instante en la zona del dueño. */
export function mesDe(at: number, timeZone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(at));
  return `${p.find((x) => x.type === 'year')?.value}-${p.find((x) => x.type === 'month')?.value}`;
}

/** Los `n` meses que acaban en el de `now` («2026-06» … «2026-11»). */
export function ultimosMeses(now: number, n: number, timeZone: string): string[] {
  const [y, m] = mesDe(now, timeZone).split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

const NOMBRE_MES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];
const etiquetaMes = (ym: string): string => {
  const [y, m] = ym.split('-');
  return `${NOMBRE_MES[Number(m) - 1] ?? m} ${y}`;
};

/** El texto de la respuesta, a partir de los cobros (sin base de datos: así se prueba). */
export function gastosTexto(
  cobros: readonly Cobro[],
  opts: { now: number; meses: number; agrupar: 'mes' | 'comercio' | 'lista'; timeZone: string },
): string {
  const meses = ultimosMeses(opts.now, opts.meses, opts.timeZone);
  const dentro = cobros.filter((c) => meses.includes(mesDe(c.at, opts.timeZone)));
  const nota =
    'Leído de tus correos de cobro (recibos, facturas, «te hemos cobrado»), no del banco: puede faltar algo o contar dos veces un mismo pago.';
  if (dentro.length === 0) {
    return `No tengo cobros apuntados en ${meses.length === 1 ? 'este mes' : `los últimos ${meses.length} meses`}. ${nota.replace(', no del banco', ' cuando el Ojo de águila (/ojo) lee tu correo, no del banco')}`;
  }
  const total = dentro.reduce((a, c) => a + c.cents, 0);
  const lines: string[] = [];
  if (opts.agrupar === 'lista') {
    const fmt = new Intl.DateTimeFormat('es-ES', {
      timeZone: opts.timeZone,
      day: '2-digit',
      month: '2-digit',
    });
    for (const c of [...dentro].sort((a, b) => b.at - a.at).slice(0, 60))
      lines.push(
        `${fmt.format(new Date(c.at))} · ${registrableDomain(c.sender)} · ${euros(c.cents)}`,
      );
    if (dentro.length > 60) lines.push(`… y ${dentro.length - 60} más`);
  } else if (opts.agrupar === 'comercio') {
    const por = new Map<string, { cents: number; n: number }>();
    for (const c of dentro) {
      const k = registrableDomain(c.sender);
      const v = por.get(k) ?? { cents: 0, n: 0 };
      v.cents += c.cents;
      v.n++;
      por.set(k, v);
    }
    for (const [k, v] of [...por].sort((a, b) => b[1].cents - a[1].cents).slice(0, 25))
      lines.push(`${k}: ${euros(v.cents)} (${v.n} ${v.n === 1 ? 'cobro' : 'cobros'})`);
  } else {
    for (const ym of meses) {
      const del = dentro.filter((c) => mesDe(c.at, opts.timeZone) === ym);
      lines.push(
        `${etiquetaMes(ym)}: ${euros(del.reduce((a, c) => a + c.cents, 0))} (${del.length} ${del.length === 1 ? 'cobro' : 'cobros'})`,
      );
    }
  }
  return [
    `${meses.length === 1 ? `Gastos de ${etiquetaMes(meses[0] ?? '')}` : `Gastos de los últimos ${meses.length} meses (${etiquetaMes(meses[0] ?? '')} – ${etiquetaMes(meses.at(-1) ?? '')})`}: ${euros(total)} en ${dentro.length} ${dentro.length === 1 ? 'cobro' : 'cobros'}.`,
    ...lines,
    nota,
    'Para una gráfica, un Excel o un PDF, pasa estas cifras a la herramienta entregable.',
  ].join('\n');
}

export function createGastosTool(deps: {
  db: DatabaseSync;
  /** Solo el dueño en su chat privado: son sus cobros. */
  allowed: () => boolean;
  now?: () => number;
  timeZone?: () => string;
}): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'gastos',
    label: 'Mis gastos',
    description:
      'Lo que el dueño ha gastado según sus correos de cobro (recibos, facturas), por mes, por comercio o cobro a cobro. Úsala para «¿cuánto he gastado este mes?», «mis gastos de los últimos meses», «¿en qué gasto más?» y para sacar los datos de «hazme una gráfica de mis gastos» (luego, entregable). Solo lectura.',
    parameters: Params(),
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const text = (): string => {
        if (!deps.allowed()) return 'Los gastos solo se consultan en el chat privado del dueño.';
        initChargeStore(deps.db);
        const meses = Math.min(24, Math.max(1, Math.round(args.meses ?? 6)));
        const now = (deps.now ?? Date.now)();
        const desde = now - (meses + 1) * 31 * 86_400_000;
        const rows = deps.db
          .prepare(
            'SELECT sender, cents, at FROM vigilante_charges WHERE at >= ? AND at <= ? AND cents > 0',
          )
          .all(desde, now) as unknown as Cobro[];
        return gastosTexto(rows, {
          now,
          meses,
          agrupar: args.agrupar ?? 'mes',
          timeZone: (deps.timeZone ?? localTimeZone)(),
        });
      };
      return { content: [{ type: 'text', text: text() }], details: {} };
    },
  };
}

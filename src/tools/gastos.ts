import type { DatabaseSync } from 'node:sqlite';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { localTimeZone } from '../datecontext.js';
import { initChargeStore, registrableDomain } from '../ojo-charges.js';
import type { PaginasVivas } from '../paginas-vivas.js';

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
    pagina: Type.Optional(
      Type.Boolean({
        description:
          'true = crea (o rehace) la página «Mis gastos» del panel (tarjeta Páginas), que luego se rehace sola con cada cobro nuevo: no hace falta rutina.',
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

/** Origen de la página «Mis gastos» que se rehace sola (una hecha a mano no se toca). */
export const GASTOS_PAGINA_ORIGEN = 'gastos (se rehace sola)';
export const GASTOS_PAGINA_TITULO = 'Mis gastos';

/** Cobros (positivos) de los últimos `meses` meses, hasta `now`. */
export function leerCobros(db: DatabaseSync, now: number, meses: number): Cobro[] {
  initChargeStore(db);
  const desde = now - (meses + 1) * 31 * 86_400_000;
  return db
    .prepare(
      'SELECT sender, cents, at FROM vigilante_charges WHERE at >= ? AND at <= ? AND cents > 0',
    )
    .all(desde, now) as unknown as Cobro[];
}

/**
 * La página «Mis gastos» del panel: este mes, los últimos 6 meses y dónde más se gasta.
 * No lleva la hora de ahora (solo la fecha del último cobro): abrir el panel sin cobros
 * nuevos no la reescribe.
 */
export function gastosPaginaTexto(
  cobros: readonly Cobro[],
  opts: { now: number; timeZone: string },
): string {
  const meses = ultimosMeses(opts.now, 6, opts.timeZone);
  const dentro = cobros.filter((c) => meses.includes(mesDe(c.at, opts.timeZone)));
  const lines = [`# ${GASTOS_PAGINA_TITULO}`];
  if (dentro.length === 0) {
    lines.push(
      'Aún no tengo cobros apuntados. Salen de tus correos de cobro cuando el Ojo de águila lee tu correo (/ojo on); esta página se rellena sola en cuanto llegue el primero.',
    );
    return lines.join('\n');
  }
  const mesActual = meses.at(-1) ?? '';
  const delMes = dentro.filter((c) => mesDe(c.at, opts.timeZone) === mesActual);
  const suma = (xs: readonly Cobro[]): number => xs.reduce((a, c) => a + c.cents, 0);
  const n = (k: number): string => `${k} ${k === 1 ? 'cobro' : 'cobros'}`;
  lines.push(
    `Este mes (${etiquetaMes(mesActual)}): ${euros(suma(delMes))} en ${n(delMes.length)}.`,
  );
  lines.push('', '## Por meses', '| Mes | Total | Cobros |', '| --- | --- | --- |');
  for (const ym of meses) {
    const del = dentro.filter((c) => mesDe(c.at, opts.timeZone) === ym);
    lines.push(`| ${etiquetaMes(ym)} | ${euros(suma(del))} | ${del.length} |`);
  }
  const por = new Map<string, Cobro[]>();
  for (const c of delMes) {
    const k = registrableDomain(c.sender);
    por.set(k, [...(por.get(k) ?? []), c]);
  }
  if (por.size > 0) {
    lines.push('', '## Dónde más este mes', '| Comercio | Total | Cobros |', '| --- | --- | --- |');
    for (const [k, xs] of [...por]
      .sort((a, b) => suma(b[1]) - suma(a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 10))
      lines.push(`| ${k} | ${euros(suma(xs))} | ${xs.length} |`);
  }
  const ultimo = Math.max(...dentro.map((c) => c.at));
  const fecha = new Intl.DateTimeFormat('es-ES', {
    timeZone: opts.timeZone,
    day: 'numeric',
    month: 'long',
  }).format(new Date(ultimo));
  lines.push(
    '',
    `Último cobro apuntado: ${fecha}. Leído de tus correos de cobro, no del banco: puede faltar algo o contar dos veces un mismo pago. Se rehace sola con cada cobro nuevo.`,
  );
  return lines.join('\n');
}

/**
 * Rehace «Mis gastos» si existe y es la automática (origen GASTOS_PAGINA_ORIGEN) y algo
 * cambió. Devuelve si la reescribió. Nunca lanza: el panel se pinta igual.
 */
export function refrescarPaginaGastos(
  db: DatabaseSync,
  paginas: PaginasVivas,
  now: number,
  timeZone: string,
): boolean {
  try {
    const p = paginas.ver(GASTOS_PAGINA_TITULO);
    if (!p || p.origen !== GASTOS_PAGINA_ORIGEN) return false;
    const texto = gastosPaginaTexto(leerCobros(db, now, 6), { now, timeZone });
    if (texto === p.contenido) return false;
    return !('error' in paginas.guardar(p.titulo, texto, GASTOS_PAGINA_ORIGEN, now));
  } catch {
    return false;
  }
}

export function createGastosTool(deps: {
  db: DatabaseSync;
  /** Solo el dueño en su chat privado: son sus cobros. */
  allowed: () => boolean;
  now?: () => number;
  timeZone?: () => string;
  /** Tarjeta Páginas: con ella, `pagina: true` crea «Mis gastos», que se rehace sola. */
  paginas?: PaginasVivas;
}): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'gastos',
    label: 'Mis gastos',
    description:
      'Lo que el dueño ha gastado según sus correos de cobro (recibos, facturas), por mes, por comercio o cobro a cobro. Úsala para «¿cuánto he gastado este mes?», «mis gastos de los últimos meses», «¿en qué gasto más?» y para sacar los datos de «hazme una gráfica de mis gastos» (luego, entregable). Con pagina=true crea la página «Mis gastos» del panel, que se rehace sola con cada cobro nuevo: úsalo para «hazme una página con mis gastos (que se actualice)», sin rutina. Sin pagina, solo lectura.',
    parameters: Params(),
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const text = (): string => {
        if (!deps.allowed()) return 'Los gastos solo se consultan en el chat privado del dueño.';
        const meses = Math.min(24, Math.max(1, Math.round(args.meses ?? 6)));
        const now = (deps.now ?? Date.now)();
        const tz = (deps.timeZone ?? localTimeZone)();
        if (args.pagina) {
          if (!deps.paginas) return 'Las páginas del panel no están disponibles aquí.';
          const r = deps.paginas.guardar(
            GASTOS_PAGINA_TITULO,
            gastosPaginaTexto(leerCobros(deps.db, now, 6), { now, timeZone: tz }),
            GASTOS_PAGINA_ORIGEN,
            now,
          );
          if ('error' in r) return r.error;
          return 'Hecha: panel → Páginas → «Mis gastos» (este mes, los últimos 6 meses y dónde más gastas). Se rehace sola con cada cobro nuevo que lea en tu correo; no hace falta rutina.';
        }
        const rows = leerCobros(deps.db, now, meses);
        return gastosTexto(rows, {
          now,
          meses,
          agrupar: args.agrupar ?? 'mes',
          timeZone: tz,
        });
      };
      return { content: [{ type: 'text', text: text() }], details: {} };
    },
  };
}

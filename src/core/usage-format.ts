import type { GoQuota } from './go-quota.js';
import type { ContextEstimate, UsageRecord, UsageReport, UsageReportTotals } from './usage.js';

/**
 * Texto de /consumo: tokens y coste estimado por dia y por modelo, mas el
 * presupuesto diario si esta configurado. Puro y determinista (sin Intl), para
 * que el mismo informe se lea igual en Windows y en CI.
 */

/** Miles con punto, siempre (Intl es-ES no agrupa los numeros de 4 cifras). */
export function formatTokens(n: number): string {
  const value = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Euros con coma; un gasto real por debajo del centimo no se muestra como 0. */
export function formatEur(micros: number): string {
  const safe = Number.isFinite(micros) && micros > 0 ? micros : 0;
  if (safe > 0 && safe < 10_000) return '<0,01 €';
  const cents = Math.round(safe / 10_000);
  const euros = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, '0');
  return `${formatTokens(euros)},${rest} €`;
}

/** YYYY-MM-DD -> DD/MM. */
function shortDay(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[2]}/${m[1]}` : day;
}

function line(t: UsageReportTotals): string {
  const calls = t.calls === 1 ? '1 llamada' : `${formatTokens(t.calls)} llamadas`;
  const cache = t.cacheReadTokens > 0 ? ` (caché ${formatTokens(t.cacheReadTokens)})` : '';
  return `${calls} · ${formatTokens(t.totalTokens)} tokens${cache} · ${formatEur(t.costMicros)}`;
}

export interface UsageFormatOptions {
  /** PA_DAILY_BUDGET_EUR; 0 o ausente = sin limite. */
  budgetEur?: number;
  /** Modelos a mostrar en el desglose; el resto se agrupa. */
  maxModels?: number;
}

export function formatUsageReport(report: UsageReport, opts: UsageFormatOptions = {}): string {
  const span = report.days.length;
  const today = report.days[0];
  const out: string[] = [];
  out.push(`Consumo de hoy${today ? ` (${shortDay(today.day)})` : ''}: ${line(report.today)}`);

  const budget = opts.budgetEur;
  if (budget !== undefined && Number.isFinite(budget) && budget > 0) {
    const budgetMicros = Math.round(budget * 1_000_000);
    const pct = Math.round((report.today.costMicros / budgetMicros) * 100);
    const over = report.today.costEur > budget;
    out.push(
      `Presupuesto diario: ${formatEur(report.today.costMicros)} de ${formatEur(budgetMicros)} (${pct} %)${
        over ? ' · superado' : ''
      }`,
    );
  } else {
    out.push('Sin presupuesto diario (PA_DAILY_BUDGET_EUR).');
  }

  if (span > 1) {
    out.push('');
    if (report.total.calls === 0) {
      out.push(`Sin consumo registrado en los últimos ${span} días.`);
    } else {
      out.push(`Últimos ${span} días: ${line(report.total)}`);
      for (const d of report.days) {
        if (d.totals.calls === 0) continue;
        out.push(
          `  ${shortDay(d.day)}  ${formatEur(d.totals.costMicros)} · ${formatTokens(d.totals.totalTokens)} tokens`,
        );
      }
    }
  }

  if (report.byModel.length > 0) {
    const max = Math.max(1, opts.maxModels ?? 5);
    out.push('');
    out.push(span > 1 ? `Por modelo (${span} días):` : 'Por modelo (hoy):');
    for (const m of report.byModel.slice(0, max)) {
      out.push(
        `  ${m.model}: ${formatEur(m.totals.costMicros)} · ${formatTokens(m.totals.totalTokens)} tokens`,
      );
    }
    const rest = report.byModel.slice(max);
    if (rest.length > 0) {
      const micros = rest.reduce((sum, m) => sum + m.totals.costMicros, 0);
      const tokens = rest.reduce((sum, m) => sum + m.totals.totalTokens, 0);
      out.push(`  otros ${rest.length}: ${formatEur(micros)} · ${formatTokens(tokens)} tokens`);
    }
  }

  if (report.contextAvg) out.push('', formatContextAvg(report.contextAvg));

  out.push('');
  out.push(
    'Tokens medidos por el proveedor; coste estimado con la tabla de precios configurada (0 € no garantiza que sea gratis).',
  );
  return out.join('\n');
}

/** Media de composición del contexto por turno: estimación heurística, etiquetada. */
export function formatContextAvg(avg: ContextEstimate & { turns: number }): string {
  const turnos = avg.turns === 1 ? '1 turno' : `${formatTokens(avg.turns)} turnos`;
  return (
    `Contexto por turno (${turnos}, estimado): sistema ${formatTokens(avg.system)} · ` +
    `memoria ${formatTokens(avg.memory)} · historial ${formatTokens(avg.history)} · ` +
    `herramientas ${formatTokens(avg.tools)}`
  );
}

/** Cuota del plan OpenCode Go: porcentajes consumidos de cada ventana. */
export function formatGoQuota(quota: GoQuota): string | null {
  const parts: string[] = [];
  if (quota.rolling) parts.push(`horas ${quota.rolling.percent} %`);
  if (quota.weekly) parts.push(`semana ${quota.weekly.percent} %`);
  if (quota.monthly) parts.push(`mes ${quota.monthly.percent} %`);
  if (parts.length === 0) return null;
  return `Cuota OpenCode Go: ${parts.join(' · ')}`;
}

/**
 * Argumento de /consumo -> dias del periodo. '' = 7, 'hoy' = 1, 'semana' = 7,
 * 'mes' = 30, un numero 1..31. null si no se entiende.
 */
export function parseUsageDays(args: string): number | null {
  // «de la semana», «del mes», «los últimos 10 días»: la respuesta dicha con palabras.
  const want = args
    .trim()
    .toLowerCase()
    .replace(/[¿?.!]+/g, '')
    .replace(/^(?:de la|de esta|de este|del|de|los|lo|el|esta|este|la|últimos|ultimos|\s)+/, '')
    .replace(/\s*d[ií]as?$/, '')
    .trim();
  if (!want || want === 'semana') return 7;
  if (want === 'hoy') return 1;
  if (want === 'mes') return 30;
  if (/^\d{1,2}$/.test(want)) {
    const n = Number(want);
    return n >= 1 && n <= 31 ? n : null;
  }
  return null;
}

/** Lista de últimos turnos: tokens medidos + composición estimada si la tienen. */
export function formatTurnList(records: UsageRecord[]): string {
  if (records.length === 0) return 'Aún no hay turnos registrados.';
  const out: string[] = ['Últimos turnos (tokens medidos; composición estimada):'];
  for (const r of records) {
    const time = /T(\d{2}:\d{2})/.exec(r.ts)?.[1] ?? '--:--';
    const cache = r.cacheReadTokens > 0 ? ` (caché ${formatTokens(r.cacheReadTokens)})` : '';
    const ctx = r.context
      ? ` · sistema ${formatTokens(r.context.system)} · memoria ${formatTokens(r.context.memory)} · historial ${formatTokens(r.context.history)} · herramientas ${formatTokens(r.context.tools)}`
      : '';
    out.push(
      `  ${time} ${r.model || 'modelo?'}: ${formatTokens(r.inputTokens)} in / ${formatTokens(r.outputTokens)} out${cache}${ctx}`,
    );
  }
  return out.join('\n');
}

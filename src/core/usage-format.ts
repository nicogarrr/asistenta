import type { UsageReport, UsageReportTotals } from './usage.js';

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
  return `${calls} · ${formatTokens(t.totalTokens)} tokens · ${formatEur(t.costMicros)}`;
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

  out.push('');
  out.push('Coste estimado con la tabla de precios configurada; 0 € no garantiza que sea gratis.');
  return out.join('\n');
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

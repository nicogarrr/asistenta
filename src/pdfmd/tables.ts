/**
 * Comprobación de tablas Markdown sin IA: código puro y determinista.
 *
 * Idea tomada de pdf2md (https://github.com/Ntizar/pdf2md, licencia MIT, `verificador.py`):
 * cuando un OCR o un modelo convierte una tabla de un PDF a Markdown, se mira que
 * 1) todas las filas tengan las mismas columnas que la cabecera (una minoría distinta se
 *    tolera: suelen ser celdas combinadas del original; si son mayoría, falla), y
 * 2) en una columna de números, el último valor sea la suma de los anteriores (tolerancia
 *    del 1 %), salvo series que solo crecen o solo bajan (2030, 2040, 2050…) sin una fila
 *    «Total» declarada.
 * Si algo no cuadra, el informe lo dice en castellano llano para avisar al usuario y, si
 * la tabla la produjo un modelo, para devolvérselo y que lo intente otra vez.
 */

const ROW = /^\s*\|(.+)\|\s*$/;
const SEP = /^\s*\|?[\s:|-]+\|?\s*$/;

export interface TableIssue {
  /** Número de tabla dentro del texto revisado (1, 2…). */
  table: number;
  /** Qué no cuadra, en castellano llano. */
  problem: string;
}

export interface TableReport {
  ok: boolean;
  /** Tablas encontradas. */
  tables: number;
  issues: TableIssue[];
}

function cells(line: string): string[] {
  const m = ROW.exec(line);
  return m ? (m[1] ?? '').split('|').map((c) => c.trim()) : [];
}

function isSeparator(line: string): boolean {
  return SEP.test(line) && line.includes('-') && line.includes('|');
}

/** «1.234,5» → 1234.5; «1,5» → 1.5; «1.5» → 1.5; «12 %» / «30 €» → número. Null si no lo es. */
export function parseNumber(raw: string): number | null {
  let t = raw.replace(/[%€$\s\u00a0]/g, '');
  if (!t) return null;
  let sign = 1;
  if (/^[+-]/.test(t)) {
    if (t[0] === '-') sign = -1;
    t = t.slice(1);
  }
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    t = t.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    t = /^\d{1,3}(,\d{3}){2,}$/.test(t) ? t.split(',').join('') : t.replace(',', '.');
  } else if (lastDot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(t)) {
    t = t.split('.').join('');
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return sign * Number(t);
}

const isPercent = (v: string) => v.trim().endsWith('%');

function checkSum(values: string[], declaredTotal: boolean): string | null {
  const nums = values.map((v) => parseNumber(v) as number);
  const total = nums[nums.length - 1] ?? 0;
  const sum = nums.slice(0, -1).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - total) <= 0.01 * Math.max(Math.abs(total), 1)) return null;
  const up = nums.every((n, i) => i === 0 || n >= (nums[i - 1] ?? n));
  const down = nums.every((n, i) => i === 0 || n <= (nums[i - 1] ?? n));
  // Serie temporal u objetivos (2030, 2040, 2050…): no es una suma, salvo «Total» declarado.
  if ((up || down) && !declaredTotal) return null;
  // Indicadores sueltos en %, o mezcla de % y números: no se suman.
  const pct = values.filter(isPercent).length;
  if (pct > 0 && (pct === values.length || !declaredTotal)) return null;
  if (declaredTotal || (total > sum && total <= sum * 1.5 && nums.length >= 3)) {
    return `la suma (${fmt(sum)}) no da el total (${fmt(total)})`;
  }
  return null;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',');

function checkTable(lines: string[], n: number, issues: TableIssue[]): void {
  const header = cells(lines[0] ?? '');
  const width = header.length;
  const rows: string[][] = [];
  let odd = 0;
  for (const line of lines.slice(2)) {
    const c = cells(line);
    if (c.length !== width) odd++;
    else rows.push(c);
  }
  if (rows.length + odd === 0 || rows.every((r) => r.every((c) => c === ''))) {
    if (odd === 0) {
      issues.push({ table: n, problem: 'está vacía: tiene cabecera pero ningún dato' });
      return;
    }
  }
  if (odd > 0 && (rows.length <= 2 || odd > Math.floor(rows.length / 2))) {
    issues.push({
      table: n,
      problem: `${odd} de ${rows.length + odd} filas no tienen ${width} columnas como la cabecera`,
    });
  }
  const last = rows[rows.length - 1];
  const declaredTotal = !!last && /total/i.test(last[0] ?? '');
  for (let col = 0; col < width; col++) {
    const values = rows.map((r) => r[col] ?? '').filter((v) => v !== '');
    if (values.length < 3 || !values.every((v) => parseNumber(v) !== null)) continue;
    const bad = checkSum(values, declaredTotal);
    if (bad) {
      const name = header[col] ? `«${header[col]}»` : `${col + 1}`;
      issues.push({ table: n, problem: `en la columna ${name} ${bad}` });
    }
  }
}

/** Busca las tablas Markdown (cabecera + separador + filas) y las comprueba. */
export function verifyTables(md: string): TableReport {
  const lines = md.split(/\r?\n/);
  const issues: TableIssue[] = [];
  let tables = 0;
  let i = 0;
  while (i < lines.length) {
    if (ROW.test(lines[i] ?? '') && isSeparator(lines[i + 1] ?? '')) {
      let j = i + 2;
      while (j < lines.length && ROW.test(lines[j] ?? '')) j++;
      tables++;
      checkTable(lines.slice(i, j), tables, issues);
      i = j;
    } else i++;
  }
  return { ok: issues.length === 0, tables, issues };
}

/** El informe en una línea por problema, para el usuario o para devolvérselo a un modelo. */
export function describeIssues(report: TableReport): string {
  return report.issues.map((x) => `Tabla ${x.table}: ${x.problem}.`).join('\n');
}

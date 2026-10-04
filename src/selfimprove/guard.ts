// Lo que el bucle NO puede tocar. Se aplica al parche candidato ANTES de medirlo.
// Mejorar relajando seguridad o cambiando la regla de medir no cuenta como mejora.

/** Prefijos/archivos intocables para el bucle. */
export const PROTECTED_PATHS: RegExp[] = [
  /^src\/permissions\.ts$/,
  /^src\/vault\.ts$/,
  /^src\/selfimprove\//,
  /^selfimprove\//, // bateria, criterios y politica
  /^src\/browser\/(ssrf|guard)[^/]*$/,
  /^src\/tools\/(approval|payment|checkout)[^/]*$/,
  /^test\/(permissions|approvals?-scope|browser-ssrf|vault|checkout)[^/]*$/,
  /^test\/selfimprove[^/]*$/,
  /^deploy\//,
  /^package(-lock)?\.json$/,
  /^\.github\//,
];

export type Violation = { file: string; rule: string };

/** Extrae los archivos tocados de un diff unificado (a/ y b/). */
export function changedFiles(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split('\n')) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      out.add(m[1] as string);
      out.add(m[2] as string);
    }
  }
  return [...out];
}

// Contenido que huele a relajar un gate. Cubre lineas anadidas, no el contexto.
const RELAX_PATTERNS: [RegExp, string][] = [
  [
    /^\+.*\b(allowActions|allowAll|skipApproval|bypassGate|autoApprove)\b/i,
    'toca la lista de permitidos/aprobaciones',
  ],
  [
    /^[+-].*\b(allowUntilPayment|PurchaseStage|stageOf)\b/,
    'toca la etapa de compra (allowUntilPayment/PurchaseStage)',
  ],
  [/^\+.*\b(PAYMENT_WORD|EFFECT_WORD)\b/, 'toca los detectores de pago/efecto'],
  [
    /^\+.*(process\.env\.)?PA_(YOLO|NO_GATE|SKIP_)\w*/i,
    'anade un interruptor para saltarse el gate',
  ],
  [/^-.*\b(requireApproval|offerApproval)\b/, 'elimina una peticion de aprobacion'],
];

/** Devuelve las violaciones; vacio = el parche puede medirse. */
export function checkPatch(diff: string): Violation[] {
  const v: Violation[] = [];
  for (const f of changedFiles(diff)) {
    if (f.includes('..') || f.startsWith('/')) v.push({ file: f, rule: 'ruta sospechosa' });
    for (const re of PROTECTED_PATHS) if (re.test(f)) v.push({ file: f, rule: 'ruta protegida' });
  }
  for (const line of diff.split('\n')) {
    for (const [re, rule] of RELAX_PATTERNS)
      if (re.test(line)) v.push({ file: '(contenido)', rule: `${rule}: ${line.slice(0, 80)}` });
  }
  // Borrar tests tambien es cambiar la regla de medir.
  if (/^deleted file mode/m.test(diff) && /^diff --git a\/test\//m.test(diff)) {
    v.push({ file: 'test/', rule: 'borra tests' });
  }
  const seen = new Set<string>();
  return v.filter((x) => {
    const k = `${x.file}|${x.rule}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

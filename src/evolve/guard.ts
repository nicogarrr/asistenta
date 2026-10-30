// Lo que el bucle NO puede tocar. Se aplica al parche candidato ANTES de medirlo.
// Mejorar relajando seguridad o cambiando la regla de medir no cuenta como mejora.

/**
 * Lo que antes solo vetaba score.ts (touchesForbidden). Prefijos: casan al principio de la
 * ruta o justo después de una «/» (igual que antes: `f.startsWith(p) || f.includes('/' + p)`).
 */
export const PROTECTED_PREFIXES: readonly string[] = [
  'src/permissions.ts',
  'src/cli.ts',
  'src/tools/checkout.ts',
  'src/tools/fetch.ts',
  'src/books/net.ts',
  'src/approval-text.ts',
  'src/vault.ts',
  'src/commerce/',
  'src/evolve/',
  'src/selfimprove/',
  'selfimprove/',
  // La regla de medir: los tests y las sondas puntúan al bucle, así que nunca los edita
  // (añadir tests infla la cuenta; borrarlos esconde un fallo).
  'test/',
  'evolve/',
  'scripts/evolve-battery-case.mjs',
  'vitest.config',
  'biome.json',
  'package.json',
  'package-lock.json',
  'tsconfig',
  '.github/',
  'deploy/',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * La ÚNICA lista de rutas intocables para el bucle: la usan checkPatch y touchesForbidden
 * (score.ts). Unir las dos listas solo puede vetar más, nunca menos.
 */
export const PROTECTED_PATHS: RegExp[] = [
  ...PROTECTED_PREFIXES.map((p) => new RegExp(`(^|/)${escapeRe(p)}`)),
  /^src\/permissions\.ts$/,
  /^src\/vault\.ts$/,
  /^src\/selfimprove\//,
  /^src\/evolve\/guard\.ts$/, // este mismo fichero (antes vivia en src/selfimprove/)
  /^selfimprove\//, // antigua carpeta de la bateria (se queda: solo mas estricto)
  /^evolve\//, // bateria (evolve/battery.json) y sondas: la regla de medir
  /^src\/evolve\/battery[^/]*$/, // como se corre y se puntua la bateria
  /^scripts\/evolve-battery-case\.mjs$/, // el evaluador que corre cada caso en la copia medida
  /^src\/browser\/(ssrf|guard)[^/]*$/,
  /^src\/tools\/(approval|payment|checkout)[^/]*$/,
  /^test\/(permissions|approvals?-scope|browser-ssrf|vault|checkout)[^/]*$/,
  /^test\/selfimprove[^/]*$/,
  /^deploy\//,
  /^package(-lock)?\.json$/,
  /^\.github\//,
];

/** ¿Toca el bucle una ruta intocable? */
export function isProtectedPath(f: string): boolean {
  return PROTECTED_PATHS.some((re) => re.test(f));
}

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
  [
    /^[+-].*\b(THREAD_ALLOW_TOOLS|threadAllow|BROWSER_FREE_ACTIONS|allowPayments|fullControl)\b/,
    'toca las listas de herramientas libres o el modo de control total',
  ],
  [/^-.*\b(requireApproval|offerApproval)\b/, 'elimina una peticion de aprobacion'],
];

/** Devuelve las violaciones; vacio = el parche puede medirse. */
export function checkPatch(diff: string): Violation[] {
  const v: Violation[] = [];
  for (const f of changedFiles(diff)) {
    if (f.includes('..') || f.startsWith('/')) v.push({ file: f, rule: 'ruta sospechosa' });
    if (isProtectedPath(f)) v.push({ file: f, rule: 'ruta protegida' });
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

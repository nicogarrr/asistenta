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
  // Sin tocar vitest.config también se cambia qué se mide: un vitest.workspace/projects en la
  // raíz sustituye su include (vitest 3 aún lo lee), vite.config lo leería si faltara, y un
  // .npmrc con node-options carga código en el `npx vitest` de la medición.
  'vitest.workspace',
  'vitest.projects',
  'vite.config',
  '.npmrc',
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
  // El control del propio bucle (decisión de Nico, 30 oct): quien propone, mide, puntúa y
  // aísla los intentos. Ya caían bajo el prefijo src/evolve/; aquí quedan nombrados.
  /^src\/evolve\/(loop|score|worktree|measure|run|receipt|archive)\.ts$/,
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
  // En Windows y macOS «src/Evolve/Loop.ts» o «src\\evolve\\loop.ts» es el mismo fichero:
  // se mira también en minúsculas, con «/» y en NFC (solo puede vetar más).
  const alt = f.normalize('NFC').replace(/\\/g, '/').toLowerCase();
  return PROTECTED_PATHS.some((re) => re.test(f) || re.test(alt));
}

export type Violation = { file: string; rule: string };

/**
 * Deshace el entrecomillado de git (core.quotePath): `"a/caf\\303\\251"` -> `a/café`.
 * Git entrecomilla nombres con comillas, barras invertidas, caracteres de control
 * o no ASCII; sin esto esos archivos no se revisaban.
 */
export function unquoteGitPath(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const body = s.slice(1, -1);
  const bytes: number[] = [];
  const esc: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(Number.parseInt(oct[0], 8) & 0xff);
      i += 3;
    } else {
      const n = body[i + 1] as string;
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Lee un nombre entrecomillado al principio de `s`; devuelve [nombre, resto] o null. */
function readQuoted(s: string): [string, string] | null {
  if (!s.startsWith('"')) return null;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return [unquoteGitPath(s.slice(0, i + 1)), s.slice(i + 1)];
  }
  return null;
}

/** Extrae los archivos tocados de un diff unificado (a/ y b/), con nombres entrecomillados. */
export function changedFiles(diff: string): string[] {
  const out = new Set<string>();
  const add = (f: string, prefix?: 'a/' | 'b/') => {
    if (prefix) {
      if (!f.startsWith(prefix)) return;
      f = f.slice(2);
    }
    if (f) out.add(f);
  };
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true;
      const rest = line.slice('diff --git '.length);
      const m = /^a\/(.+?) b\/(.+)$/.exec(rest);
      if (m) {
        add(m[1] as string);
        add(m[2] as string);
        continue;
      }
      // Entrecomillado (uno o ambos lados).
      const q1 = readQuoted(rest);
      if (q1) {
        add(q1[0], 'a/');
        const r = q1[1].trimStart();
        const q2 = readQuoted(r);
        if (q2) add(q2[0], 'b/');
        else add(r, 'b/');
      } else {
        const i = rest.indexOf(' "b/');
        if (i > 0) {
          add(rest.slice(0, i), 'a/');
          const q2 = readQuoted(rest.slice(i + 1));
          if (q2) add(q2[0], 'b/');
        }
      }
      continue;
    }
    if (!header) continue;
    if (line.startsWith('@@')) {
      header = false;
      continue;
    }
    // Cabeceras del archivo: sin ambiguedad por espacios y con el mismo entrecomillado.
    const h = /^(---|\+\+\+|rename from|rename to|copy from|copy to) (.+)$/.exec(line);
    if (!h) continue;
    const name = unquoteGitPath(h[2] as string);
    if (h[1] === '---') add(name, 'a/');
    else if (h[1] === '+++') add(name, 'b/');
    else add(name);
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
  if (/^deleted file mode/m.test(diff) && /^diff --git "?a\/test\//m.test(diff)) {
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

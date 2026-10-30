import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { log } from './log.js';

/**
 * Ojo de águila, pantalla (opt-in). Cada barrido, y solo si el dueño lo encendió con
 * `/ojo pantalla on`: una captura de pantalla completa a un temporal, OCR local de Windows,
 * y la imagen se borra siempre. Nada de la captura ni del texto OCR bruto se guarda: solo
 * hallazgos ya redactados (una línea con fecha/plazo o importe y contexto de pago).
 *
 * Es conservador: solo prueba positiva (palabra de contexto Y fecha explícita o importe en la
 * MISMA línea). Lo ambiguo no genera nada. Y falla cerrado: si no puede comprobar qué ventanas
 * hay abiertas, o hay alguna de la lista de exclusión (bancos, gestores de contraseñas,
 * incógnito, salud...), no captura.
 */

const SETTING_KEY = 'screen_enabled';
export const SCREEN_STALE_MS = 12 * 60 * 60 * 1000;
/** Mismo hallazgo (misma huella) no se repite en este plazo. */
export const SCREEN_DEDUPE_MS = 7 * 24 * 60 * 60 * 1000;
/** Las filas (ya sin texto) se borran pasado este plazo. */
export const SCREEN_PURGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PENDING = 20;
const MAX_LISTED = 5;
const SNIPPET_MAX = 110;

export function initScreenStore(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS vigilante_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_screen (
      key TEXT PRIMARY KEY,
      snippet TEXT NOT NULL,
      at INTEGER NOT NULL,
      status TEXT NOT NULL
    )
  `);
}

/** Apagado por defecto: solo `on` explícito lo enciende. */
export function getScreenEnabled(db: DatabaseSync): boolean {
  initScreenStore(db);
  const row = db.prepare('SELECT value FROM vigilante_settings WHERE key = ?').get(SETTING_KEY) as
    | { value: string }
    | undefined;
  return row?.value === 'on';
}

export function setScreenEnabled(db: DatabaseSync, enabled: boolean): void {
  initScreenStore(db);
  db.prepare(
    'INSERT INTO vigilante_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SETTING_KEY, enabled ? 'on' : 'off');
  // Al apagar, lo pendiente se descarta: no debe aparecer después, fuera de contexto.
  if (!enabled)
    db.prepare(
      "UPDATE vigilante_screen SET status = 'descartada', snippet = '' WHERE status = 'pendiente'",
    ).run();
}

// ---------------------------------------------------------------------------------------
// Exclusión por título de ventana o proceso (amplia a propósito: ante la duda, no se captura)
// ---------------------------------------------------------------------------------------

const EXCLUDED_TITLE: readonly RegExp[] = [
  /banc[oa]|bank|santander|bbva|caixa|sabadell|bankinter|unicaja|abanca|openbank|ing direct|ing\.es|kutxa|ibercaja|cajamar|evo banco|n26|revolut|wise|paypal|bizum|stripe|tarjeta|card|iban|cuenta/i,
  /contrase[ñn]a|password|passkey|bitwarden|keepass|1password|lastpass|dashlane|proton pass|nordpass|keeper|enpass|vault|bóveda|boveda|secret|credencial|credential|2fa|authenticator|otp|c[oó]digo de verificaci/i,
  /inc[oó]gnito|incognito|inprivate|navegaci[oó]n privada|private browsing|private window|ventana privada/i,
  /salud|health|m[eé]dic|cl[ií]nic|hospital|sanitas|adeslas|asisa|mutua|doctoralia|receta|analítica|analitica|diagn[oó]stic|urgencias|farmacia|pharmacy|psic[oó]l|terapia|embarazo/i,
  /hacienda|agencia tributaria|seguridad social|cl@ve|cl\.ve|certificado digital|dni|pasaporte|binance|coinbase|wallet|cartera|metamask|ledger|trezor|crypto|cripto/i, // Diálogos de credenciales de Windows, más neobancos/brókers/exchanges y trámites públicos.
  /seguridad de windows|windows security|control de cuentas de usuario|user account control|credenciales de windows|tor browser/i,
  /\bimagin\b|myinvestor|trade republic|degiro|monzo|kraken|bit2me|bitpanda|indexa capital|interactive brokers|etoro/i,
  /clave pin|carpeta ciudadana|muface|sede electr[oó]nica/i,
];
const EXCLUDED_PROCESS: readonly RegExp[] = [
  /bitwarden|keepass|1password|lastpass|dashlane|nordpass|enpass|keeper|proton ?pass|authy|authenticator|metamask|ledger|trezor/i,
  /credentialuibroker|consent\.exe|^tor(\.exe)?$|firefox.*tor/i,
];

export interface WindowLite {
  title: string;
  process: string;
}

export function isExcludedWindow(w: WindowLite): boolean {
  return (
    EXCLUDED_TITLE.some((re) => re.test(w.title)) ||
    EXCLUDED_PROCESS.some((re) => re.test(w.process))
  );
}

// ---------------------------------------------------------------------------------------
// Redacción
// ---------------------------------------------------------------------------------------

const HIDDEN = '[oculto]';

/** A line that talks about a one-time code, PIN or key (see `redact`). */
// A digit right after the word does not end the match: «PIN1234» or «código482913»
// glue the code to the word and must still count. Phrases that name a one-time code
// without any of the words («válido para un solo uso», «your one-time 4829»,
// «autenticación en dos pasos: 731942») count too.
const OTP_HINT =
  /(?:^|[^\p{L}\p{N}])(c[oó]digo|code|otp|pin|clave|contrase[ñn]a|password|passcode|token|2fa|cvv|cvc|verificaci[oó]n|verification|un solo uso|one[- ]?time|single[- ]use|dos pasos|doble factor|two[- ]?factor|two[- ]?step|2[- ]step|autenticaci[oó]n|authentication)(?!\p{L})/iu;

/** Quita control, formato (bidi, ZW...), sin asignar y privado; colapsa espacios. */
function clean(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\p{C}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Redacción estricta: todo lo que parezca identificador, secreto o dato de contacto se
 * sustituye antes de persistir o enviar. Se prefiere ocultar de más.
 */
export function redact(input: string): string {
  let s = clean(input);
  // Línea con palabra de secreto: se oculta lo que sigue. Detrás de la palabra
  // basta con que no siga una letra: con `\b`, «PIN1234» (código pegado) se escapaba.
  s = s.replace(
    /\b(contrase[ñn]a|password|passwd|pwd|token|secret[oa]?|api[ -]?key|clave|pin|cvv|cvc|c[oó]digo|code|otp|2fa|passcode|nacimiento|birth)(?![A-Za-z_])\s*[:=]?\s*\S.*$/gi,
    (_m, k: string) => `${k} ${HIDDEN}`,
  );
  // Emails.
  // Cualquier token con @ en medio (incluye letras no ASCII, ñ, acentos, dominios IDN).
  s = s.replace(/[^\s@]*\s?@\s?[^\s@]*/g, HIDDEN);
  // IBAN (con o sin espacios).
  s = s.replace(
    /\b[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]{4}){2,7}(?:[ -]?[A-Za-z0-9]{1,4})?\b/g,
    HIDDEN,
  );
  // URLs completas: pueden llevar tokens (también sin esquema, «www.…»).
  s = s.replace(/\bhttps?:\/\/\S+/gi, HIDDEN);
  s = s.replace(/\bwww\.\S+/gi, HIDDEN);
  // Claves enteras ANTES de mirar dígitos: si no, «sk-ABC…123» deja ver el prefijo.
  s = s.replace(/[A-Za-z0-9_\-+/=]{20,}/g, (m) =>
    /[A-Za-z]/.test(m) && /\d/.test(m) ? HIDDEN : m,
  );
  // Secuencias largas de dígitos (tarjetas, DNI/NIE, teléfonos, cuentas), con separadores.
  s = s.replace(/(?:\+?\d[\d .-]{7,}\d)/g, (m, off: number, all: string) =>
    isDateLike(m) || isAmountLike(m, all.slice(off + m.length)) ? m : HIDDEN,
  );
  s = s.replace(/\b\d{9,}\b/g, HIDDEN);
  // DNI / NIE.
  s = s.replace(/\b[XYZxyz]?\d{7,8}[ -]?[A-Za-z]\b/g, HIDDEN);
  // Cadenas de alta entropía (tokens, claves, hashes): 20+ caracteres sin espacios con mezcla.
  s = s.replace(/\b[A-Za-z0-9_\-+/=]{20,}\b/g, HIDDEN);
  s = s.replace(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{12,}\b/g, HIDDEN);
  // The keyword rule hides what comes AFTER «código»/«code»/«PIN»… but a code
  // written BEFORE it («123456 es tu código para confirmar el pago de 49,99 €», the
  // usual bank/3DS and Google «G-482913 es tu código» shape) stayed in clear. On a
  // line that names a code, every short digit run is hidden wherever it sits.
  // Runs last, so IBANs, cards and phones are already matched whole above.
  if (OTP_HINT.test(s)) s = s.replace(/(?<![\d,.])\d{4,8}(?![\d,.]\d)/g, HIDDEN);
  return s.replace(/\s+/g, ' ').trim();
}

function isDateLike(m: string): boolean {
  return /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(\s+\d{1,2}[.:]\d{2})?$/.test(m.trim());
}

/** Importe con miles ("1.234.567" seguido de ",89"): no es un identificador. */
function isAmountLike(m: string, after: string): boolean {
  return /^\d{1,3}(\.\d{3})+$/.test(m) && /^,\d{2}(?!\d)/.test(after);
}

// ---------------------------------------------------------------------------------------
// Hallazgos: solo prueba positiva
// ---------------------------------------------------------------------------------------

const CONTEXT =
  /\b(vence|vencimiento|vencen|caduca|caducidad|plazo|fecha l[ií]mite|l[ií]mite de pago|factura|pago|pagar|a pagar|importe|total|recibo|cargo|cobro|deuda|renovaci[oó]n|renueva)\b/i;
const MONTHS =
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre';
const DATE_NUM = /\b(0?[1-9]|[12]\d|3[01])[/.-](0?[1-9]|1[0-2])(?:[/.-](\d{4}|\d{2}))?\b/;
const DATE_TXT = new RegExp(
  `\\b(0?[1-9]|[12]\\d|3[01])\\s+de\\s+(${MONTHS})(?:\\s+de\\s+\\d{4})?\\b`,
  'i',
);
// clean() pasa NFKC + \s+ -> ' ', así que el espacio duro/estrecho/fino de «1 299,00» llega
// como espacio normal: con el símbolo delante («€ 1 299,00», «EUR 1 299,00») también es importe.
const AMOUNT =
  /(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}\s?(?:€|eur\b|euros\b)|(?:€|eur\s)\s?\d{1,3}(?:[. ]\d{3})*,\d{2}|\d{1,6}\s?(?:€|euros\b)/i;

export interface ScreenFinding {
  key: string;
  snippet: string;
}

export const fingerprint = (snippet: string): string =>
  createHash('sha256').update(snippet.toLowerCase()).digest('hex').slice(0, 24);

/** Líneas con contexto de pago/plazo Y (fecha explícita o importe). Todo lo demás: nada. */
export function findScreenFindings(lines: readonly string[]): ScreenFinding[] {
  const out = new Map<string, ScreenFinding>();
  for (const raw of lines) {
    const line = clean(raw);
    if (line.length < 6 || line.length > 400) continue;
    if (!CONTEXT.test(line)) continue;
    if (!(DATE_NUM.test(line) || DATE_TXT.test(line) || AMOUNT.test(line))) continue;
    let snippet = redact(line);
    if (snippet.length > SNIPPET_MAX) snippet = `${snippet.slice(0, SNIPPET_MAX - 1)}…`;
    // Si tras redactar no queda contexto ni fecha/importe, no aporta: fuera.
    if (
      !CONTEXT.test(snippet) ||
      !(DATE_NUM.test(snippet) || DATE_TXT.test(snippet) || AMOUNT.test(snippet))
    )
      continue;
    const key = fingerprint(snippet);
    if (!out.has(key)) out.set(key, { key, snippet });
  }
  return [...out.values()];
}

export function recordScreenFindings(
  db: DatabaseSync,
  findings: readonly ScreenFinding[],
  now: number,
): number {
  initScreenStore(db);
  if (!getScreenEnabled(db)) return 0;
  let added = 0;
  for (const f of findings) {
    const pending = Number(
      (
        db
          .prepare("SELECT count(*) AS n FROM vigilante_screen WHERE status = 'pendiente'")
          .get() as {
          n: number;
        }
      ).n,
    );
    if (pending >= MAX_PENDING) break;
    const prev = db.prepare('SELECT at FROM vigilante_screen WHERE key = ?').get(f.key) as
      | { at: number }
      | undefined;
    if (prev && now - prev.at < SCREEN_DEDUPE_MS) continue;
    db.prepare(
      "INSERT INTO vigilante_screen (key, snippet, at, status) VALUES (?, ?, ?, 'pendiente') ON CONFLICT(key) DO UPDATE SET snippet = excluded.snippet, at = excluded.at, status = 'pendiente'",
    ).run(f.key, f.snippet, now);
    added++;
  }
  return added;
}

export interface PendingScreen {
  key: string;
  snippet: string;
  at: number;
}

export function pendingScreen(db: DatabaseSync, now: number): PendingScreen[] {
  initScreenStore(db);
  if (!getScreenEnabled(db)) return [];
  db.prepare(
    "UPDATE vigilante_screen SET status = 'descartada', snippet = '' WHERE status = 'pendiente' AND at < ?",
  ).run(now - SCREEN_STALE_MS);
  // Solo hace falta la huella para el dedupe de 7 días: nada más allá de 30 días.
  db.prepare('DELETE FROM vigilante_screen WHERE at < ?').run(now - SCREEN_PURGE_MS);
  return db
    .prepare(
      "SELECT key, snippet, at FROM vigilante_screen WHERE status = 'pendiente' ORDER BY at, rowid",
    )
    .all() as unknown as PendingScreen[];
}

export function markScreenNotified(db: DatabaseSync, keys: readonly string[]): void {
  if (keys.length === 0) return;
  const upd = db.prepare(
    "UPDATE vigilante_screen SET status = 'avisada', snippet = '' WHERE key = ? AND status = 'pendiente'",
  );
  for (const k of keys) upd.run(k);
}

export function formatScreen(items: readonly PendingScreen[]): string {
  const shown = items.slice(0, MAX_LISTED);
  const lines = shown.map((i) => `• ${redact(i.snippet)}`);
  const more = items.length - shown.length;
  if (more > 0) lines.push(`• y ${more} más`);
  return [
    '🖥️ En tu pantalla vi (lectura OCR, puede fallar; solo miro un instante cada barrido y no guardo la captura):',
    ...lines,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------
// Escaneo
// ---------------------------------------------------------------------------------------

export type ScanOutcome = { ok: true; found: number } | { ok: false; reason: string };

export interface ScreenScanDeps {
  db: DatabaseSync;
  interactive: () => Promise<boolean>;
  windows: () => Promise<WindowLite[]>;
  /** Captura a un temporal; `cleanup` borra la imagen (se llama SIEMPRE). */
  capture: () => Promise<{ path: string; cleanup: () => void }>;
  ocr: (path: string) => Promise<string[]>;
  now?: () => number;
  /** Tope por paso (por defecto 30 s). */
  ocrTimeoutMs?: number;
  /** Presupuesto total del escaneo (por defecto 45 s). */
  budgetMs?: number;
}

function deadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label}: más de ${ms} ms`)), Math.max(1, ms));
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Presupuesto total de un escaneo: por debajo del tope del barrido (60 s). */
export const SCAN_BUDGET_MS = 45_000;

type Shot = { path: string; cleanup: () => void };

/** Comprueba ventanas: fail-closed (no se pudo listar, o lista vacía, o alguna excluida). */
async function windowsSafe(deps: ScreenScanDeps, ms: number): Promise<string | null> {
  let ws: WindowLite[];
  try {
    ws = await deadline(deps.windows(), ms, 'ventanas');
  } catch {
    return 'no pude comprobar qué ventanas hay abiertas';
  }
  if (ws.length === 0) return 'no pude comprobar qué ventanas hay abiertas';
  if (ws.some(isExcludedWindow)) return 'hay una ventana de la lista de exclusión abierta';
  return null;
}

export async function scanScreenOnce(deps: ScreenScanDeps): Promise<ScanOutcome> {
  const started = Date.now();
  const budget = deps.budgetMs ?? SCAN_BUDGET_MS;
  const step = deps.ocrTimeoutMs ?? 30_000;
  // Cada paso espera como mucho `step` y nunca más de lo que queda del presupuesto total.
  const left = (): number => Math.min(step, budget - (Date.now() - started));
  if (!getScreenEnabled(deps.db)) return { ok: false, reason: 'apagado' };
  if (!(await deadline(deps.interactive(), left(), 'escritorio').catch(() => false)))
    return { ok: false, reason: 'no hay escritorio interactivo' };
  if (!getScreenEnabled(deps.db)) return { ok: false, reason: 'apagado' };
  const before = await windowsSafe(deps, left());
  if (before) return { ok: false, reason: before };

  // La captura puede terminar DESPUÉS de que nos rindamos: si llega tarde, se borra igual.
  let abandoned = false;
  let landed: Shot | null = null;
  const safeCleanup = (s: Shot): void => {
    try {
      s.cleanup();
    } catch (err) {
      log.warn('pantalla: no se pudo borrar la captura', { err: String(err) });
    }
  };
  const capP = deps.capture();
  capP.then(
    (s) => {
      landed = s;
      if (abandoned) safeCleanup(s);
    },
    () => {},
  );
  try {
    const shot = await deadline(capP, left(), 'captura');
    // Otra comprobación DESPUÉS de capturar: si apareció algo excluido entre medias, se tira.
    const after = await windowsSafe(deps, left());
    if (after) return { ok: false, reason: after };
    if (!getScreenEnabled(deps.db)) return { ok: false, reason: 'apagado' };
    const lines = await deadline(deps.ocr(shot.path), left(), 'OCR');
    // Off durante el OCR: no se guarda nada.
    if (!getScreenEnabled(deps.db)) return { ok: false, reason: 'apagado' };
    const found = recordScreenFindings(
      deps.db,
      findScreenFindings(lines),
      (deps.now ?? Date.now)(),
    );
    return { ok: true, found };
  } catch (err) {
    log.warn('pantalla: no se pudo leer', { err: String(err) });
    return { ok: false, reason: 'no pude leer la pantalla' };
  } finally {
    abandoned = true;
    if (landed) safeCleanup(landed);
  }
}

/** Texto honesto del último intento (en memoria: tras reiniciar, aún no hay ninguno). */
export function screenStatusText(last: ScanOutcome | null): string {
  if (!last) return 'Aún no he mirado desde que arrancó el asistente.';
  return last.ok ? 'La última lectura fue bien.' : `La última vez no miré: ${last.reason}.`;
}

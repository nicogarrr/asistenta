import { normalizeDomain } from '../gestor/login.js';
import { listAccounts, metaKey, realVault, type VaultOps } from './store.js';

/**
 * El sí de «crear cuenta», atado en código al clic.
 *
 * `cuentas confirmar_registro` solo llega a ejecutarse tras el sí del dueño en la Gate
 * (regla ask-cuentas-registro, sin memo ni «siempre») y entonces deja en la cuenta
 * pendiente `approvedAt` + `approvedEmail`. Este módulo es el otro extremo: una vez que
 * la contraseña de esa cuenta pendiente se ha escrito en una página, el navegador no
 * hace clic ni pulsa teclas en ella sin ese sí, reciente y para esa web y ese correo.
 * Lo mismo cuando la web no pide contraseña y lo que se escribe es el correo del alta.
 */
export const SIGNUP_APPROVAL_TTL_MS = 10 * 60_000;

export const SIGNUP_NEEDS_APPROVAL = (domain: string, email: string): string =>
  `No he hecho clic: el formulario de alta en ${domain} ya tiene la contraseña y falta el sí del dueño. ` +
  `Llama antes a cuentas confirmar_registro con sitio=${domain} y correo=${email}` +
  ' (o cuentas descartar si no sigues).';

/** El campo `password` de una clave site:<dominio>:password, o null. */
export function signupPasswordDomain(secretKey: unknown): string | null {
  if (typeof secretKey !== 'string') return null;
  const m = /^site:([^:]+):password$/i.exec(secretKey.trim());
  return m?.[1] ? normalizeDomain(m[1]) : null;
}

/**
 * Altas sin contraseña (enlace o código por correo): dominios con un alta pendiente cuyo
 * correo es `text` y cuya web es la página actual (con o sin www). Sin URL conocida
 * cuentan todas las altas pendientes con ese correo: mejor frenar de más que de menos.
 */
export async function signupEmailDomains(
  text: unknown,
  pageUrl: string | undefined,
  vault: VaultOps = realVault,
): Promise<string[]> {
  if (typeof text !== 'string' || !text.includes('@')) return [];
  const email = text.trim().toLowerCase();
  let host: string | null = null;
  try {
    host = pageUrl ? normalizeDomain(new URL(pageUrl).hostname) : null;
  } catch {
    host = null;
  }
  return (await listAccounts(vault))
    .filter((a) => a.status === 'pendiente' && a.username.trim().toLowerCase() === email)
    .filter((a) => host === null || host === a.domain || host.endsWith(`.${a.domain}`))
    .map((a) => a.domain);
}

/**
 * ¿Puede el navegador actuar en una página donde se escribió la contraseña de `domains`?
 * Devuelve el motivo del rechazo o null. Quita de `domains` las que ya no son un alta
 * pendiente (guardada o descartada): esas no frenan nada.
 */
export async function signupSubmitBlock(
  domains: Set<string>,
  vault: VaultOps = realVault,
  now: number = Date.now(),
): Promise<string | null> {
  if (domains.size === 0) return null;
  const pending = new Map(
    (await listAccounts(vault)).filter((a) => a.status === 'pendiente').map((a) => [a.domain, a]),
  );
  for (const d of [...domains]) {
    const p = pending.get(d);
    if (!p) {
      domains.delete(d);
      continue;
    }
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse((await vault.get(metaKey(d))) ?? '{}') as Record<string, unknown>;
    } catch {
      meta = {};
    }
    const at = meta.approvedAt;
    const fresh =
      typeof at === 'number' &&
      at <= now &&
      now - at <= SIGNUP_APPROVAL_TTL_MS &&
      meta.approvedEmail === p.username;
    if (!fresh) return SIGNUP_NEEDS_APPROVAL(d, p.username);
  }
  return null;
}

/**
 * El escritorio (herramienta `computer`) no sabe en qué web está: un clic o un Enter en una
 * ventana de navegador de verdad puede enviar el alta que el navegador dejó a medias. Aquí
 * se apuntan, para todo el PC, las altas pendientes ya escritas (por el navegador o
 * tecleando su correo en el escritorio). Caducan a los 30 min; antes, solo las suelta el sí
 * del dueño (confirmar_registro), guardar o descartar.
 */
export const DESKTOP_SIGNUP_ARM_TTL_MS = 30 * 60_000;
const desktopArmed = new Map<string, number>();

export function armDesktopSignup(domains: Iterable<string>, now: number = Date.now()): void {
  for (const d of domains) desktopArmed.set(d, now);
}

/** Solo para pruebas. */
export function resetDesktopSignup(): void {
  desktopArmed.clear();
}

/** ¿Esta acción del escritorio puede enviar un formulario? (clic, Enter, texto con salto). */
function desktopSubmits(item: Record<string, unknown>): boolean {
  if (item.action === 'click') return true;
  if (item.action === 'key') return /enter|return/i.test(String(item.key ?? ''));
  if (item.action === 'type') return /[\r\n]/.test(String(item.text ?? ''));
  return false;
}

/**
 * Freno de altas para una llamada de `computer` (o un batch entero). Si teclea el correo de
 * un alta pendiente, la arma antes de nada (sin web conocida: todas las de ese correo). Si
 * hay un clic, un Enter o un salto de línea y alguna alta armada no tiene el sí reciente,
 * devuelve el motivo y no se hace nada de la llamada.
 */
export async function desktopSignupBlock(
  args: Record<string, unknown>,
  vault: VaultOps = realVault,
  now: number = Date.now(),
): Promise<string | null> {
  const items =
    args.action === 'batch' && Array.isArray(args.actions)
      ? (args.actions as unknown[]).filter(
          (x): x is Record<string, unknown> => typeof x === 'object' && x !== null,
        )
      : [args];
  for (const it of items) {
    if (it.action === 'type' && it.secret !== true && String(it.text ?? '').includes('@')) {
      const typed = await signupEmailDomains(it.text, undefined, vault).catch(() => []);
      armDesktopSignup(typed, now);
    }
  }
  if (desktopArmed.size === 0 || !items.some(desktopSubmits)) return null;
  const domains = new Set<string>();
  for (const [d, at] of desktopArmed) {
    if (now - at > DESKTOP_SIGNUP_ARM_TTL_MS) desktopArmed.delete(d);
    else domains.add(d);
  }
  try {
    const block = await signupSubmitBlock(domains, vault, now);
    for (const d of desktopArmed.keys()) if (!domains.has(d)) desktopArmed.delete(d);
    return block;
  } catch {
    return DESKTOP_SIGNUP_UNKNOWN;
  }
}

export const DESKTOP_SIGNUP_UNKNOWN =
  'No he hecho clic: hay un alta de cuenta a medias y no he podido comprobar si tiene el sí del dueño. ' +
  'Llama antes a cuentas confirmar_registro (o cuentas descartar si no sigues).';

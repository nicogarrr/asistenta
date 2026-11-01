import { randomInt } from 'node:crypto';
import { normalizeDomain, siteKey } from '../gestor/login.js';
import { vaultDelete, vaultGet, vaultList, vaultSet } from '../vault.js';

/**
 * Gestor de contraseñas de Asistenta, encima del vault cifrado (no es otro almacén).
 * Cada cuenta usa la convención de login del gestor: `site:<dominio>:username` y
 * `site:<dominio>:password`, así el navegador ya sabe rellenarla con `secret_key` sin
 * que el valor pase nunca por el modelo. Lo que no es secreto (alta, notas, estado)
 * va en `cuenta:<dominio>` como JSON. Nada de aquí devuelve la contraseña: solo
 * `revealPassword`, que usa la CLI local (portapapeles / exportar), la lee.
 */

/**
 * Aviso del gestor o del registro, ya escrito en castellano llano para el dueño.
 * Cualquier otro error (lectura/escritura del vault, disco…) es técnico: solo va al log.
 */
export class AvisoCuenta extends Error {
  override name = 'AvisoCuenta';
}

export interface VaultOps {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<string[]>;
}

export const realVault: VaultOps = {
  get: vaultGet,
  set: vaultSet,
  delete: vaultDelete,
  list: vaultList,
};

export type AccountStatus = 'activa' | 'pendiente';

/** Una cuenta tal como se puede enseñar: sin contraseña, nunca. */
export interface Account {
  domain: string;
  username: string;
  created: string;
  notes: string;
  status: AccountStatus;
}

const META_PREFIX = 'cuenta:';

export function metaKey(domain: string): string {
  return `${META_PREFIX}${domain}`;
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!#$%&*+-=?@_';

export interface PasswordRules {
  /** Largo deseado (por defecto 24; nunca menos de 20 salvo que la web ponga un máximo menor). */
  length?: number;
  /** Máximo que admite la web. */
  maxLength?: number;
  /** false si la web no admite símbolos. */
  symbols?: boolean;
  /** Símbolos que admite la web (si da una lista). */
  allowedSymbols?: string;
}

const pick = (set: string): string => set.charAt(randomInt(set.length));

/** Contraseña fuerte con el RNG criptográfico: al menos una minúscula, mayúscula, cifra (y símbolo). */
export function generatePassword(rules: PasswordRules = {}): string {
  const symbols =
    rules.symbols === false
      ? ''
      : [...new Set((rules.allowedSymbols ?? SYMBOLS).split(''))]
          .filter((c) => /[\x21-\x7e]/.test(c) && !/[A-Za-z0-9]/.test(c))
          .join('');
  let length = Math.max(20, Math.floor(rules.length ?? 24));
  if (rules.maxLength !== undefined && rules.maxLength > 0)
    length = Math.min(length, rules.maxLength);
  const sets = [LOWER, UPPER, DIGITS, ...(symbols ? [symbols] : [])];
  if (length < sets.length) length = sets.length;
  const all = sets.join('');
  const chars = sets.map(pick);
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}

function parseMeta(domain: string, raw: string | undefined, username: string): Account {
  let m: Partial<Account> = {};
  try {
    m = raw ? (JSON.parse(raw) as Partial<Account>) : {};
  } catch {
    m = {};
  }
  return {
    domain,
    username,
    created: typeof m.created === 'string' ? m.created : '',
    notes: typeof m.notes === 'string' ? m.notes : '',
    status: m.status === 'pendiente' ? 'pendiente' : 'activa',
  };
}

/**
 * Dominios tal como están en las claves `site:<d>:password`, agrupados por dominio normal
 * (sin www, en minúsculas): `pa vault set-stdin site:www.wallapop.es:password` y una cuenta de
 * wallapop.es son la misma web. El primero de cada lista es el que se lee (el exacto si lo hay).
 */
async function keyDomains(vault: VaultOps): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const k of await vault.list()) {
    const raw = /^site:([^:]+):password$/.exec(k)?.[1];
    const domain = raw ? normalizeDomain(raw) : null;
    if (!raw || !domain) continue;
    const list = out.get(domain) ?? [];
    if (raw === domain) list.unshift(raw);
    else list.push(raw);
    out.set(domain, list);
  }
  return out;
}

/** Todas las cuentas con contraseña guardada, una por web. Sin contraseñas. */
export async function listAccounts(vault: VaultOps = realVault): Promise<Account[]> {
  const out: Account[] = [];
  const groups = await keyDomains(vault);
  for (const domain of [...groups.keys()].sort()) {
    const raw = groups.get(domain)?.[0] ?? domain;
    const username = (await vault.get(siteKey(raw, 'username'))) ?? '';
    out.push(parseMeta(domain, await vault.get(metaKey(raw)), username));
  }
  return out;
}

/** «¿Tengo cuenta en Wallapop?»: busca por dominio o por nombre suelto. */
export async function findAccounts(query: string, vault: VaultOps = realVault): Promise<Account[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const domain = normalizeDomain(q);
  const all = await listAccounts(vault);
  // Con un dominio («wallapop.es») solo esa web y sus subdominios: wallapop.es y
  // es.wallapop.com son webs distintas, y «x.es» no es «fax.es».
  if (domain?.includes('.') && !/\s/.test(q)) {
    return all.filter((a) => a.domain === domain || a.domain.endsWith(`.${domain}`));
  }
  const word = q.replace(/^www\./, '').split(/[./\s]/)[0] ?? q;
  return all.filter(
    (a) => a.domain === domain || a.domain.split('.').includes(word) || a.domain.includes(q),
  );
}

export interface SaveInput {
  site: string;
  username: string;
  /** Si no viene, se genera una fuerte. */
  password?: string;
  notes?: string;
  status?: AccountStatus;
  rules?: PasswordRules;
  now?: Date;
}

/** Guarda (o actualiza) una cuenta. Devuelve la cuenta SIN contraseña. */
export async function saveAccount(input: SaveInput, vault: VaultOps = realVault): Promise<Account> {
  const domain = normalizeDomain(input.site);
  if (!domain)
    throw new AvisoCuenta('No reconozco esa web: dime el dominio, por ejemplo wallapop.es.');
  const username = input.username.trim();
  if (!username) throw new AvisoCuenta('Falta el usuario o correo de la cuenta.');
  const password = input.password ?? generatePassword(input.rules);
  const prev = parseMeta(domain, await vault.get(metaKey(domain)), username);
  const account: Account = {
    domain,
    username,
    created: prev.created || (input.now ?? new Date()).toISOString(),
    notes: input.notes ?? prev.notes,
    status: input.status ?? 'activa',
  };
  await vault.set(siteKey(domain, 'username'), username);
  await vault.set(siteKey(domain, 'password'), password);
  await vault.set(
    metaKey(domain),
    JSON.stringify({ created: account.created, notes: account.notes, status: account.status }),
  );
  return account;
}

/** Borra la cuenta del gestor (las tres claves; también las de www.<web> si las hay). */
export async function deleteAccount(site: string, vault: VaultOps = realVault): Promise<boolean> {
  const domain = normalizeDomain(site);
  if (!domain) return false;
  let had = false;
  for (const raw of new Set([domain, ...((await keyDomains(vault)).get(domain) ?? [])])) {
    if (await vault.delete(siteKey(raw, 'password'))) had = true;
    await vault.delete(siteKey(raw, 'username'));
    await vault.delete(metaKey(raw));
  }
  return had;
}

/**
 * La contraseña en claro. SOLO para la CLI local del PC (portapapeles, exportar):
 * nunca para una herramienta del modelo, el chat, Telegram ni el registro.
 */
export async function revealPassword(
  site: string,
  vault: VaultOps = realVault,
): Promise<string | undefined> {
  const domain = normalizeDomain(site);
  if (!domain) return undefined;
  const raw = (await keyDomains(vault)).get(domain)?.[0] ?? domain;
  return vault.get(siteKey(raw, 'password'));
}

/** n…@gmail.com: el correo reconocible sin escribirlo entero en el chat. */
export function maskUser(user: string): string {
  const at = user.indexOf('@');
  if (at > 0) return `${user.charAt(0)}…${user.slice(at)}`;
  return user.length <= 2
    ? `${user.charAt(0)}…`
    : `${user.charAt(0)}…${user.charAt(user.length - 1)}`;
}

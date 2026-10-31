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

/** Todas las cuentas con contraseña guardada, por dominio. Sin contraseñas. */
export async function listAccounts(vault: VaultOps = realVault): Promise<Account[]> {
  const keys = await vault.list();
  const domains = new Set<string>();
  for (const k of keys) {
    const m = /^site:([^:]+):password$/.exec(k);
    if (m?.[1]) domains.add(m[1]);
  }
  const out: Account[] = [];
  for (const domain of [...domains].sort()) {
    const username = (await vault.get(siteKey(domain, 'username'))) ?? '';
    out.push(parseMeta(domain, await vault.get(metaKey(domain)), username));
  }
  return out;
}

/** «¿Tengo cuenta en Wallapop?»: busca por dominio o por nombre suelto. */
export async function findAccounts(query: string, vault: VaultOps = realVault): Promise<Account[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const domain = normalizeDomain(q);
  const word = q.replace(/^www\./, '').split(/[./\s]/)[0] ?? q;
  return (await listAccounts(vault)).filter(
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
  if (!domain) throw new Error('No reconozco esa web: dime el dominio, por ejemplo wallapop.es.');
  const username = input.username.trim();
  if (!username) throw new Error('Falta el usuario o correo de la cuenta.');
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

/** Borra la cuenta del gestor (las tres claves). */
export async function deleteAccount(site: string, vault: VaultOps = realVault): Promise<boolean> {
  const domain = normalizeDomain(site);
  if (!domain) return false;
  const had = await vault.delete(siteKey(domain, 'password'));
  await vault.delete(siteKey(domain, 'username'));
  await vault.delete(metaKey(domain));
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
  return domain ? vault.get(siteKey(domain, 'password')) : undefined;
}

/** n…@gmail.com: el correo reconocible sin escribirlo entero en el chat. */
export function maskUser(user: string): string {
  const at = user.indexOf('@');
  if (at > 0) return `${user.charAt(0)}…${user.slice(at)}`;
  return user.length <= 2
    ? `${user.charAt(0)}…`
    : `${user.charAt(0)}…${user.charAt(user.length - 1)}`;
}

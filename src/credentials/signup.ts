import { normalizeDomain } from '../gestor/login.js';
import {
  type Account,
  deleteAccount,
  listAccounts,
  maskUser,
  metaKey,
  type PasswordRules,
  realVault,
  saveAccount,
  type VaultOps,
} from './store.js';

/**
 * «Créame una cuenta en X», en cuatro pasos que el modelo no puede saltarse:
 * 1. preparar: genera la contraseña y la deja en el vault como cuenta «pendiente»
 *    (el navegador la escribe con `secret_key`, el valor nunca pasa por el modelo).
 * 2. el modelo rellena el formulario con el nombre y correo del dueño (de .env, nunca inventados).
 * 3. confirmar: la Gate lo pregunta SIEMPRE con «Voy a crear tu cuenta en X con tu correo n…@…»
 *    antes de pulsar el botón; sin ese sí, la cuenta no se crea.
 * 4. guardar cuando la web confirme el alta, o descartar si no sale (borra la pendiente).
 * Captchas, códigos por SMS o correo y planes de pago no se resuelven aquí: son del dueño.
 */

export interface OwnerIdentity {
  name: string;
  email: string;
}

/** Nombre y correo del dueño: PA_OWNER_NAME / PA_OWNER_EMAIL, o el correo de envío del vault. */
export async function ownerIdentity(
  env: NodeJS.ProcessEnv = process.env,
  vault: VaultOps = realVault,
): Promise<OwnerIdentity | null> {
  const name = env.PA_OWNER_NAME?.trim() ?? '';
  const email = env.PA_OWNER_EMAIL?.trim() || (await vault.get('mailSend:address'))?.trim() || '';
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { name, email };
}

export const MISSING_IDENTITY =
  'Me faltan tu nombre y tu correo para registrarte: ponlos en .env (PA_OWNER_NAME y PA_OWNER_EMAIL) y vuelve a pedírmelo.';

async function rawMeta(domain: string, vault: VaultOps): Promise<Record<string, unknown>> {
  try {
    return JSON.parse((await vault.get(metaKey(domain))) ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function pendingOf(site: string, vault: VaultOps): Promise<Account | null> {
  const domain = normalizeDomain(site);
  if (!domain) return null;
  return (
    (await listAccounts(vault)).find((a) => a.domain === domain && a.status === 'pendiente') ?? null
  );
}

export async function prepareSignup(
  site: string,
  owner: OwnerIdentity,
  rules: PasswordRules = {},
  vault: VaultOps = realVault,
): Promise<Account> {
  const domain = normalizeDomain(site);
  if (!domain) throw new Error('No reconozco esa web: dime el dominio, por ejemplo wallapop.es.');
  const existing = (await listAccounts(vault)).find((a) => a.domain === domain);
  if (existing?.status === 'activa') {
    throw new Error(
      `Ya tienes cuenta en ${domain} (${maskUser(existing.username)}); no creo otra.`,
    );
  }
  return saveAccount({ site: domain, username: owner.email, rules, status: 'pendiente' }, vault);
}

/** El sí del dueño (ya dado por la Gate): solo vale para la pendiente y el correo exactos que vio. */
export async function approveSignup(
  site: string,
  correo: string,
  vault: VaultOps = realVault,
): Promise<Account> {
  const p = await pendingOf(site, vault);
  if (!p) throw new Error('No hay ningún registro preparado para esa web.');
  if (p.username !== correo.trim())
    throw new Error('Ese correo no es el del registro preparado; no sigo.');
  await vault.set(
    metaKey(p.domain),
    JSON.stringify({ ...(await rawMeta(p.domain, vault)), approvedAt: Date.now() }),
  );
  return p;
}

/** La web confirmó el alta: la cuenta pasa a activa. Solo si el dueño la había aprobado. */
export async function finishSignup(site: string, vault: VaultOps = realVault): Promise<Account> {
  const p = await pendingOf(site, vault);
  if (!p) throw new Error('No hay ningún registro pendiente para esa web.');
  const meta = await rawMeta(p.domain, vault);
  if (typeof meta.approvedAt !== 'number')
    throw new Error('Ese registro no está aprobado todavía.');
  await vault.set(
    metaKey(p.domain),
    JSON.stringify({ created: p.created, notes: p.notes, status: 'activa' }),
  );
  return { ...p, status: 'activa' };
}

/** El alta no salió: borra la pendiente. Nunca toca una cuenta activa. */
export async function discardSignup(site: string, vault: VaultOps = realVault): Promise<boolean> {
  const p = await pendingOf(site, vault);
  if (!p) return false;
  return deleteAccount(p.domain, vault);
}

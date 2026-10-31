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

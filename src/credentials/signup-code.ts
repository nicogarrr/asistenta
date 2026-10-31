import { loadReadMailAccount } from '../mail/idle.js';
import { readReplyThread, searchInbox } from '../mail/reader.js';
import { pendingOf } from './signup.js';
import { AvisoCuenta, metaKey, realVault, type VaultOps } from './store.js';

/**
 * El código de verificación de un alta, leído del correo del dueño.
 *
 * Solo para un alta pendiente que el dueño ya aprobó (confirmar_registro), solo correos
 * de esa web llegados desde la aprobación, y solo devuelve los dígitos: nunca el correo
 * entero ni un enlace. Si la web manda un enlace de confirmación en vez de un código, no
 * se abre: se le dice al dueño que lo abra él. La Gate pregunta cada vez (ask-cuentas-codigo).
 */
export interface CodeMail {
  from: string;
  subject: string;
  at: number;
  text: string;
}
/** Correos de `from` desde `since`, o null si no hay correo configurado. */
export type MailSearch = (query: { from: string; since: number }) => Promise<CodeMail[] | null>;

/** La bandeja del dueño (mailRead), solo lectura: como mucho los 5 más nuevos de esa web. */
export const realSignupMail: MailSearch = async (q) => {
  const account = await loadReadMailAccount().catch(() => null);
  if (!account) return null;
  const out: CodeMail[] = [];
  for (const row of await searchInbox(account, q, 5)) {
    const m = await readReplyThread(account, row.ref).catch(() => null);
    if (m) out.push({ from: row.from, subject: row.subject, at: row.at, text: m.text });
  }
  return out;
};

/** Ventana máxima tras el sí del dueño para buscar el correo del código. */
export const SIGNUP_CODE_WINDOW_MS = 30 * 60_000;

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const KEYWORD_CODE =
  /(?:c[oó]digo|code|verificaci[oó]n|verification|confirmaci[oó]n|otp|pin)\D{0,40}?(?<![\d-])(\d{4,8})(?![\d-])/i;
const LONE_SIX = /(?<![\d-])(\d{6})(?![\d-])/;

export type CodeFound = { code: string } | { linkOnly: true } | null;

/** Los dígitos del código (4–8), o que solo trae un enlace, o nada. Nunca mira dentro de URLs. */
export function extractSignupCode(subject: string, text: string): CodeFound {
  const hadLink = URL_RE.test(text);
  URL_RE.lastIndex = 0;
  const clean = `${subject}\n${text}`.replace(URL_RE, ' ');
  const m = KEYWORD_CODE.exec(clean) ?? LONE_SIX.exec(subject) ?? LONE_SIX.exec(clean);
  if (m?.[1]) return { code: m[1] };
  return hadLink ? { linkOnly: true } : null;
}

/** «wallapop» de wallapop.es: lo que suele salir en el remitente de esa web. */
const brand = (domain: string): string => domain.split('.').slice(-2, -1)[0] ?? domain;

export async function findSignupCode(
  site: string,
  search: MailSearch = realSignupMail,
  vault: VaultOps = realVault,
  now: number = Date.now(),
): Promise<string> {
  let p: Awaited<ReturnType<typeof pendingOf>>;
  try {
    // «el código de wallapop»: el nombre a secas vale si solo encaja un alta (como guardar/descartar).
    p = await pendingOf(site, vault, true);
  } catch (err) {
    if (err instanceof AvisoCuenta) return err.message;
    throw err;
  }
  if (!p) return 'No hay ningún alta en marcha para esa web.';
  const domain = p.domain;
  let approvedAt: unknown;
  try {
    approvedAt = (JSON.parse((await vault.get(metaKey(domain))) ?? '{}') as Record<string, unknown>)
      .approvedAt;
  } catch {
    approvedAt = undefined;
  }
  if (typeof approvedAt !== 'number' || now - approvedAt > SIGNUP_CODE_WINDOW_MS)
    return `El alta de ${domain} no está aprobada ahora mismo: antes llama a cuentas confirmar_registro.`;
  const b = brand(domain);
  const found = await search({ from: b, since: approvedAt - 2 * 60_000 }).catch(() => null);
  if (!found)
    return 'No puedo leer tu correo ahora (no está configurado o no responde): pídele al dueño el código.';
  const mails = found
    .filter((m) => m.at >= approvedAt - 2 * 60_000 && m.from.toLowerCase().includes(b))
    .sort((x, y) => y.at - x.at);
  let link = false;
  for (const m of mails) {
    const hit = extractSignupCode(m.subject, m.text);
    if (hit && 'code' in hit)
      return `Código de ${domain}: ${hit.code}. Escríbelo en el formulario.`;
    if (hit) link = true;
  }
  if (link)
    return `El correo de ${domain} trae un enlace de confirmación, no un código. No abro enlaces de correos: dile al dueño que lo abra él.`;
  return `Todavía no ha llegado ningún correo de ${domain} con un código. Espera un poco o pídeselo al dueño.`;
}

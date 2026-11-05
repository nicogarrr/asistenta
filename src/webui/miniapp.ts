/**
 * Mini App de Telegram: el panel se abre con un toque desde el chat (botón /panel o /voz)
 * y entra sin pegar el token. Telegram abre la página con `#tgWebAppData=<initData>`;
 * la página lo manda a /api/miniapp y aquí se comprueba la firma con el token del bot
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * clave = HMAC-SHA256("WebAppData", token del bot); hash = HMAC-SHA256(clave, datos
 * ordenados «k=v» separados por saltos de línea, sin `hash`). Solo vale si el usuario
 * firmado es el dueño y la firma tiene menos de un día. Sin token del bot o sin dueño
 * configurado, siempre es no.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MINIAPP_MAX_AGE_S = 24 * 3600;

export function signInitData(fields: Record<string, string>, botToken: string): string {
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = Object.keys(fields)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  return createHmac('sha256', secret).update(check).digest('hex');
}

/**
 * ¿`initData` (la query string que manda Telegram) está firmada por este bot, es del
 * dueño y es reciente? `now` en milisegundos.
 */
export function verifyInitData(
  initData: string,
  botToken: string | undefined,
  ownerId: number | string | null | undefined,
  now: number = Date.now(),
  maxAgeS: number = MINIAPP_MAX_AGE_S,
): boolean {
  if (!botToken || ownerId === null || ownerId === undefined || String(ownerId) === '')
    return false;
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 4096) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) return false;
  const fields: Record<string, string> = {};
  for (const [k, v] of params) if (k !== 'hash') fields[k] = v;
  const expected = Buffer.from(signInitData(fields, botToken), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return false;
  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate) || Math.abs(now / 1000 - authDate) > maxAgeS) return false;
  let user: unknown;
  try {
    user = JSON.parse(fields.user ?? '');
  } catch {
    return false;
  }
  const id = (user as { id?: unknown } | null)?.id;
  return id !== undefined && String(id) === String(ownerId);
}

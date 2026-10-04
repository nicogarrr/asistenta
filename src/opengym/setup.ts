/**
 * Dónde viven la URL y el token de openGym.
 *
 * El token es un secreto: va al vault cifrado (`opengym:token`), nunca al código ni al
 * log. Para despliegues sin vault cifrado también se acepta PA_OPENGYM_TOKEN. La URL no
 * es secreta: `opengym:url` en el vault o PA_OPENGYM_URL.
 */
import { vaultGet, vaultSet } from '../vault.js';
import { OpenGymClient, OpenGymError, parseBaseUrl, redeemPairingCode } from './client.js';

export const NOT_CONFIGURED =
  'openGym no está configurado. Pasos: 1) Tailscale encendido en este PC; 2) en openGym, Ajustes > emparejar la app móvil, que da un código de 8 caracteres; 3) en el PC: pa opengym pair <URL> <CÓDIGO>';

async function settings(): Promise<{ url: string | undefined; token: string | undefined }> {
  const url = process.env.PA_OPENGYM_URL?.trim() || (await vaultGet('opengym:url'));
  const token = (await vaultGet('opengym:token')) || process.env.PA_OPENGYM_TOKEN?.trim();
  return { url: url?.trim() || undefined, token: token?.trim() || undefined };
}

/** Cliente listo para usar, o null si falta la URL o el token. */
export async function makeOpenGymClient(): Promise<OpenGymClient | null> {
  const { url, token } = await settings();
  if (!url || !token) return null;
  return new OpenGymClient({
    baseUrl: url,
    getToken: async () => (await vaultGet('opengym:token')) || token,
    setToken: (t) => vaultSet('opengym:token', t),
  });
}

/** `pa opengym pair [URL] <CÓDIGO>`: canjea el código y guarda URL y token en el vault. */
export async function pairOpenGym(urlArg: string | undefined, code: string): Promise<string> {
  const url = urlArg?.trim() || (await settings()).url;
  if (!url)
    throw new OpenGymError('config', 'falta la URL de openGym: pa opengym pair <URL> <CÓDIGO>');
  const base = parseBaseUrl(url);
  const token = await redeemPairingCode(base.toString(), code);
  await vaultSet('opengym:url', base.toString().replace(/\/$/, ''));
  await vaultSet('opengym:token', token);
  return base.host;
}

import { rmSync } from 'node:fs';
import { pickLanAddress, type ServedFile, serveFileToHost } from './lan-server.js';

/**
 * Reproducir un audio en la tele LG (webOS).
 *
 * La tele no recibe bytes: abre una URL. El MP3 se sirve con un servidor efímero
 * que solo acepta a la tele (lan-server.ts) y se le pide abrirlo con el visor
 * multimedia de webOS (`media.viewer/open`). Si esa API no existe en el modelo, se
 * prueba `system.launcher/open` con la misma URL (lo abre el navegador de la tele,
 * que reproduce MP3). Ninguna de las dos está verificada en la tele real de Nico:
 * por eso todo esto está apagado por defecto (PA_AUDIO_TELE=1 lo enciende).
 */

export type SsapRequest = (
  uri: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface TvCastDeps {
  /** IP de la tele (tv:host). */
  tvHost: string;
  ssap: SsapRequest;
  /** Inyectables para pruebas. */
  pickAddress?: (tvHost: string) => string | null;
  serve?: typeof serveFileToHost;
  ttlMs?: number;
}

export interface TvCastResult {
  ok: boolean;
  /** Texto en español para el modelo/usuario. */
  message: string;
  via?: 'media.viewer' | 'launcher';
  url?: string;
}

export function audioTeleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|on|si|sí|true)$/i.test((env.PA_AUDIO_TELE ?? '').trim());
}

/**
 * Sirve `file` a la tele y le pide reproducirlo. El fichero pasa a ser de este módulo:
 * se borra cuando el servidor se cierra (ttl) o enseguida si algo falla.
 */
export async function castAudioToTv(
  file: string,
  deps: TvCastDeps,
  title = 'Asistenta',
): Promise<TvCastResult> {
  const bindIp = (deps.pickAddress ?? pickLanAddress)(deps.tvHost);
  if (!bindIp) {
    rmSync(file, { force: true });
    return {
      ok: false,
      message:
        'No encuentro una red del PC en la misma subred que la tele, así que no puedo servirle el audio.',
    };
  }
  let served: ServedFile;
  try {
    served = await (deps.serve ?? serveFileToHost)({
      file,
      bindIp,
      allowIp: deps.tvHost,
      mimeType: 'audio/mpeg',
      ttlMs: deps.ttlMs,
    });
  } catch (err) {
    return {
      ok: false,
      message: `No he podido abrir el servidor para la tele: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const errors: string[] = [];
  try {
    await deps.ssap('media.viewer/open', {
      target: served.url,
      title,
      description: 'Audio desde Telegram',
      mimeType: 'audio/mpeg',
      loop: false,
    });
    return {
      ok: true,
      via: 'media.viewer',
      url: served.url,
      message: 'He mandado el audio a la tele; no puedo confirmar que se haya oído.',
    };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  try {
    await deps.ssap('system.launcher/open', { target: served.url });
    return {
      ok: true,
      via: 'launcher',
      url: served.url,
      message:
        'La tele no tiene visor multimedia por API; lo he abierto con su navegador. No puedo confirmar que se haya oído.',
    };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  served.close();
  return { ok: false, message: `La tele no ha aceptado el audio: ${errors.join(' / ')}` };
}

type VaultGet = (key: string) => Promise<string | null | undefined>;
type TvRequestFn = (
  host: string,
  clientKey: string,
  uri: string,
  payload: Record<string, unknown>,
  deps?: { allowPlaintext?: boolean },
) => Promise<Record<string, unknown>>;

/**
 * El "caster" que usa el daemon: lee el emparejamiento del vault igual que la tool
 * `tv` (tv:host / tv:clientKey / tv:secure) sin tocar su cableado.
 */
export function tvCasterFromVault(
  vaultGet: VaultGet,
  request: TvRequestFn,
  extra: Partial<Pick<TvCastDeps, 'pickAddress' | 'serve' | 'ttlMs'>> = {},
): (file: string) => Promise<TvCastResult> {
  return async (file) => {
    const host = await vaultGet('tv:host');
    const clientKey = await vaultGet('tv:clientKey');
    if (!host || !clientKey) {
      rmSync(file, { force: true });
      return {
        ok: false,
        message: 'La tele no está emparejada. Empareja una vez con: pa tv setup <ip-de-la-tele>',
      };
    }
    const allowPlaintext = (await vaultGet('tv:secure')) === '0';
    return castAudioToTv(file, {
      tvHost: host,
      ssap: (uri, payload) => request(host, clientKey, uri, payload, { allowPlaintext }),
      ...extra,
    });
  };
}

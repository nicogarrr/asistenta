import { rmSync } from 'node:fs';
import { log } from '../log.js';
import { GlasshouseClient } from '../tv/glasshouse.js';
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
  /**
   * Tercera vía: Glasshouse (API de la tele rooteada) abre la URL. Solo existe si
   * tv:glasshouseUrl está configurado.
   */
  glasshouse?: (url: string) => Promise<void>;
  /** Probar solo una vía (pa audio prueba-tele --via …). */
  only?: TvCastVia;
}

export type TvCastVia = 'media.viewer' | 'launcher' | 'glasshouse';
export const TV_CAST_VIAS: readonly TvCastVia[] = ['media.viewer', 'launcher', 'glasshouse'];

/** Aviso cuando la tele aceptó la orden pero nunca descargó el fichero. */
export const TV_FIREWALL_HINT =
  'La tele no ha podido descargar el audio. Suele ser el firewall de Windows: permite Node.js en redes privadas (Panel de control → Firewall de Windows Defender → Permitir una aplicación) y comprueba que la red Wi-Fi del PC está como «privada».';

/**
 * El aviso del firewall sale una sola vez por sesión del daemon, venga de donde venga
 * (altavoz en la tele o «reprodúcelo en la tele»): la causa es la misma, repetirlo cansa.
 */
let teleFirewallWarned = false;

/** ¿Ya se avisó del firewall en esta sesión? */
export function teleFirewallAlreadyWarned(): boolean {
  return teleFirewallWarned;
}

/** Marca el aviso como dado. Devuelve false si otro camino ya lo había dado. */
export function claimTeleFirewallWarning(): boolean {
  if (teleFirewallWarned) return false;
  teleFirewallWarned = true;
  return true;
}

/** Solo para pruebas: vuelve a permitir el aviso del firewall. */
export function resetTeleFirewallWarning(): void {
  teleFirewallWarned = false;
}

export interface TvCastResult {
  ok: boolean;
  /** Texto en español para el modelo/usuario. */
  message: string;
  via?: TvCastVia;
  url?: string;
  /** Errores de las vías que fallaron antes, en orden. */
  tried?: string[];
  /** Cuántas veces ha descargado la tele el fichero (para avisar del firewall). */
  hits?: () => number;
  /**
   * Para ESTA nota en la tele (/stop). Con media.viewer es media.controls/stop; si se
   * abrió con el navegador (launcher) o Glasshouse, además cierra la app que abrió el
   * cast, solo si sigue en primer plano y nunca el inicio ni la TV en directo.
   */
  stop?: () => Promise<void>;
}

const TV_FOREGROUND = 'com.webos.applicationManager/getForegroundAppInfo';
/** Apps que parar una nota no cierra nunca. */
const TV_NEVER_CLOSE = new Set([
  'com.webos.app.home',
  'com.webos.app.livetv',
  'com.webos.app.launcher',
  'com.webos.app.discovery',
]);

function appIdOf(res: unknown): string | undefined {
  if (!res || typeof res !== 'object') return undefined;
  const r = res as Record<string, unknown>;
  const id = r.appId ?? r.id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
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
  const foreground = async (): Promise<string | undefined> => {
    try {
      return appIdOf(await deps.ssap(TV_FOREGROUND, {}));
    } catch {
      return undefined;
    }
  };
  /** App en primer plano antes de abrir con Glasshouse (para saber cuál abrió el cast). */
  let ghBefore: string | undefined;
  const stopFor = (via: TvCastVia, opened: unknown) => {
    const mediaStop = () => deps.ssap('media.controls/stop', {});
    if (via === 'media.viewer') {
      return async (): Promise<void> => {
        await mediaStop();
      };
    }
    const launched = via === 'launcher' ? appIdOf(opened) : undefined;
    const before = via === 'glasshouse' ? ghBefore : undefined;
    return async (): Promise<void> => {
      try {
        await mediaStop();
      } catch {
        // Una URL abierta en el navegador no siempre atiende a media.controls.
      }
      const fg = await foreground();
      if (!fg || TV_NEVER_CLOSE.has(fg)) return;
      // Solo la app de NUESTRO cast: la que devolvió launcher, o la que apareció con
      // Glasshouse (si no sabemos qué había antes, no se cierra nada).
      if (launched ? fg !== launched : before === undefined || fg === before) return;
      await deps.ssap('system.launcher/close', { id: fg });
    };
  };
  const attempts: Array<[TvCastVia, () => Promise<unknown>, string]> = [
    [
      'media.viewer',
      () =>
        deps.ssap('media.viewer/open', {
          target: served.url,
          title,
          description: 'Audio desde Telegram',
          mimeType: 'audio/mpeg',
          loop: false,
        }),
      'He mandado el audio a la tele; no puedo confirmar que se haya oído.',
    ],
    [
      'launcher',
      () => deps.ssap('system.launcher/open', { target: served.url }),
      'La tele no tiene visor multimedia por API; lo he abierto con su navegador. No puedo confirmar que se haya oído.',
    ],
  ];
  const gh = deps.glasshouse;
  if (gh) {
    attempts.push([
      'glasshouse',
      async () => {
        ghBefore = await foreground();
        await gh(served.url);
      },
      'La tele no aceptó el audio por webOS; lo he abierto con Glasshouse. No puedo confirmar que se haya oído.',
    ]);
  }
  for (const [via, run, message] of attempts) {
    if (deps.only && deps.only !== via) continue;
    try {
      const opened = await run();
      return {
        ok: true,
        via,
        url: served.url,
        message,
        tried: errors.length ? [...errors] : undefined,
        hits: () => served.hits(),
        stop: stopFor(via, opened),
      };
    } catch (err) {
      errors.push(`${via}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (deps.only === 'glasshouse' && !gh) {
    errors.push('glasshouse: no está configurado (tv:glasshouseUrl)');
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
  deps?: {
    allowPlaintext?: boolean;
    onNewClientKey?: (clientKey: string) => void | Promise<void>;
  },
) => Promise<Record<string, unknown>>;

/**
 * El "caster" que usa el daemon: lee el emparejamiento del vault igual que la tool
 * `tv` (tv:host / tv:clientKey / tv:secure) sin tocar su cableado.
 */
/**
 * /stop con /altavoz tele: para lo que la tele está reproduciendo (ssap
 * media.controls/stop). Devuelve false sin tocar nada si la tele no está emparejada.
 */
export function tvStopperFromVault(
  vaultGet: VaultGet,
  request: TvRequestFn,
): () => Promise<boolean> {
  return async () => {
    const host = await vaultGet('tv:host');
    const clientKey = await vaultGet('tv:clientKey');
    if (!host || !clientKey) return false;
    const allowPlaintext = (await vaultGet('tv:secure')) === '0';
    await request(host, clientKey, 'media.controls/stop', {}, { allowPlaintext });
    return true;
  };
}

export function tvCasterFromVault(
  vaultGet: VaultGet,
  request: TvRequestFn,
  extra: Partial<Pick<TvCastDeps, 'pickAddress' | 'serve' | 'ttlMs' | 'only'>> & {
    /**
     * Guarda la client-key nueva (tv:clientKey) si la tele se re-empareja durante
     * el cast, igual que la tool `tv`. Sin esto la clave se perdía y cada audio
     * volvía a sacar el aviso de emparejamiento en la tele.
     */
    saveClientKey?: (clientKey: string) => Promise<void>;
  } = {},
): (file: string) => Promise<TvCastResult> {
  const { saveClientKey, ...castExtra } = extra;
  return async (file) => {
    const host = await vaultGet('tv:host');
    const storedKey = await vaultGet('tv:clientKey');
    if (!host || !storedKey) {
      rmSync(file, { force: true });
      return {
        ok: false,
        message: 'La tele no está emparejada. Empareja una vez con: pa tv setup <ip-de-la-tele>',
      };
    }
    let clientKey = storedKey;
    const allowPlaintext = (await vaultGet('tv:secure')) === '0';
    const ghUrl = (await vaultGet('tv:glasshouseUrl'))?.trim();
    const glasshouse = ghUrl
      ? async (url: string): Promise<void> => {
          const endpoints = ghUrl
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const client = new GlasshouseClient({
            endpoints,
            token: await vaultGet('tv:glasshouseToken'),
          });
          await client.control('url', url);
        }
      : undefined;
    const onNewClientKey = saveClientKey
      ? async (key: string): Promise<void> => {
          // La siguiente vía de este mismo cast ya usa la clave nueva.
          clientKey = key;
          try {
            await saveClientKey(key);
            log.info('tv-cast: la tele se ha vuelto a emparejar; client-key nueva guardada');
          } catch (err) {
            log.warn('tv-cast: no he podido guardar la client-key nueva', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      : undefined;
    return castAudioToTv(file, {
      tvHost: host,
      ssap: (uri, payload) =>
        request(host, clientKey, uri, payload, {
          allowPlaintext,
          ...(onNewClientKey ? { onNewClientKey } : {}),
        }),
      glasshouse,
      ...castExtra,
    });
  };
}

/**
 * Estado EN VIVO de la tele, solo lectura y sin captura: ¿esta encendida?,
 * ¿que app o entrada tiene delante?, ¿a que volumen? Responde "que esta
 * viendo" o "esta la tele encendida" sin despertar nada ni gastar una imagen.
 *
 * Cada lectura es independiente: si una falla, ese dato queda como
 * desconocido (null) y el resto sigue. Si la tele no acepta la conexion
 * (TvUnreachableError) se dice "apagada o fuera de red": SSAP no distingue
 * "apagada del todo" de "sin wifi", y no se afirma lo que no se sabe.
 */
import { TvUnreachableError } from './lgtv.js';

export type TvSsap = (uri: string, payload: Record<string, unknown>) => Promise<unknown>;

export interface TvStatusDeps {
  ssap: TvSsap;
  /** Apps instaladas, para traducir el appId a su titulo (opcional). */
  apps?: () => Promise<Array<{ id: string; title: string }>>;
  now?: () => Date;
}

export type TvPowerWord =
  | 'encendida'
  | 'pantalla apagada'
  | 'en reposo'
  | 'apagada o fuera de red'
  | 'desconocido';

export interface TvStatus {
  reachable: boolean;
  power: TvPowerWord;
  /** Texto crudo de getPowerState (Active, Screen Off, Active Standby...). */
  powerState: string | null;
  appId: string | null;
  /** Nombre legible de lo que hay delante (Netflix, HDMI 2, TV...). */
  showing: string | null;
  input: string | null;
  volume: number | null;
  muted: boolean | null;
  checkedAt: string;
}

/** Nombres conocidos de apps de webOS (ids estables de la LG Content Store). */
export const KNOWN_APPS: Record<string, string> = {
  netflix: 'Netflix',
  'youtube.leanback.v4': 'YouTube',
  amazon: 'Prime Video',
  'com.disney.disneyplus-prod': 'Disney+',
  'spotify-beehive': 'Spotify',
  'com.apple.appletv': 'Apple TV',
  'com.webos.app.browser': 'el navegador',
  'com.webos.app.home': 'el menu de inicio',
  'com.webos.app.livetv': 'la TV (antena)',
  'com.webos.app.photovideo': 'Fotos y videos',
  'com.webos.app.music': 'Musica',
  'org.webosbrew.hbchannel': 'Homebrew Channel',
};

/** Entrada a partir del appId en primer plano (com.webos.app.hdmi2 -> HDMI 2). */
export function inputFromAppId(appId: string | null | undefined): string | null {
  if (!appId) return null;
  const hdmi = /^com\.webos\.app\.hdmi(\d)$/.exec(appId);
  if (hdmi) return `HDMI ${hdmi[1]}`;
  if (appId === 'com.webos.app.livetv') return 'TV';
  return null;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function powerWord(state: string | null): TvPowerWord {
  switch (state) {
    case 'Active':
      return 'encendida';
    case 'Screen Off':
    case 'Screen Saver':
      return 'pantalla apagada';
    case 'Active Standby':
    case 'Suspend':
      return 'en reposo';
    default:
      return 'desconocido';
  }
}

/** Volumen en las dos formas de webOS: plana (antigua) o volumeStatus (webOS 5+). */
export function parseVolume(res: unknown): { volume: number | null; muted: boolean | null } {
  const r = rec(res);
  const vs = rec(r.volumeStatus);
  const rawVol = typeof vs.volume === 'number' ? vs.volume : r.volume;
  const rawMute = typeof vs.muteStatus === 'boolean' ? vs.muteStatus : r.muted;
  const volume =
    typeof rawVol === 'number' && Number.isFinite(rawVol) && rawVol >= 0 && rawVol <= 100
      ? rawVol
      : null;
  return { volume, muted: typeof rawMute === 'boolean' ? rawMute : null };
}

export async function readTvStatus(deps: TvStatusDeps): Promise<TvStatus> {
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const unknown: TvStatus = {
    reachable: false,
    power: 'apagada o fuera de red',
    powerState: null,
    appId: null,
    showing: null,
    input: null,
    volume: null,
    muted: null,
    checkedAt,
  };
  // Primero el estado de energia: si no conecta, no tiene sentido seguir
  // abriendo sockets contra una tele que no esta.
  let powerState: string | null = null;
  try {
    const p = rec(await deps.ssap('com.webos.service.tvpower/power/getPowerState', {}));
    powerState = typeof p.state === 'string' ? p.state.slice(0, 40) : null;
  } catch (err) {
    if (err instanceof TvUnreachableError) return unknown;
    powerState = null;
  }
  const [fg, vol] = await Promise.allSettled([
    deps.ssap('com.webos.applicationManager/getForegroundAppInfo', {}),
    deps.ssap('audio/getVolume', {}),
  ]);
  if (fg.status === 'rejected' && fg.reason instanceof TvUnreachableError) return unknown;
  const appIdRaw = fg.status === 'fulfilled' ? rec(fg.value).appId : undefined;
  const appId = typeof appIdRaw === 'string' && appIdRaw.length ? appIdRaw.slice(0, 200) : null;
  const { volume, muted } =
    vol.status === 'fulfilled' ? parseVolume(vol.value) : { volume: null, muted: null };
  const input = inputFromAppId(appId);
  let showing: string | null = input ?? (appId ? (KNOWN_APPS[appId] ?? null) : null);
  if (appId && !showing && deps.apps) {
    try {
      const title = (await deps.apps()).find((a) => a.id === appId)?.title;
      if (typeof title === 'string' && title.trim()) showing = title.trim().slice(0, 80);
    } catch {
      // sin lista de apps: queda el appId
    }
  }
  if (appId && !showing) showing = appId;
  return {
    reachable: true,
    // Responde por SSAP pero getPowerState fallo: al menos esta viva.
    power: powerState ? powerWord(powerState) : appId ? 'encendida' : 'desconocido',
    powerState,
    appId,
    showing,
    input,
    volume,
    muted,
    checkedAt,
  };
}

/** Una frase en castellano para el usuario. */
export function describeTvStatus(s: TvStatus): string {
  if (!s.reachable) {
    return 'La tele no responde: esta apagada del todo o fuera de la red (no puedo distinguir cual).';
  }
  const parts: string[] = [];
  switch (s.power) {
    case 'encendida':
      parts.push('La tele esta encendida');
      break;
    case 'pantalla apagada':
      parts.push('La tele esta encendida con la pantalla apagada');
      break;
    case 'en reposo':
      parts.push('La tele esta en reposo (apagada, pero escucha)');
      break;
    default:
      parts.push('La tele responde, pero no se si la pantalla esta encendida');
  }
  if (s.power !== 'en reposo' && s.showing) {
    parts.push(s.input ? `con la entrada ${s.input}` : `con ${s.showing} delante`);
  }
  let out = `${parts.join(' ')}.`;
  if (s.volume !== null) out += ` Volumen ${s.volume}${s.muted ? ' (silenciada)' : ''}.`;
  else if (s.muted) out += ' Esta silenciada.';
  return out;
}

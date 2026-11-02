/**
 * Cliente REST de Sony Bravia (IP Control con Pre-Shared Key).
 *
 * Protocolo (documentacion oficial de Sony, pro-bravia.sony.net):
 *   POST http://IP/sony/<servicio>
 *   X-Auth-PSK: <clave>
 *   {"method": "...", "params": [...], "id": N, "version": "1.0"}
 * Servicios: system, audio, avContent, appControl, video...
 *
 * En la tele, Nico (una vez, con el mando): Ajustes > Red > Home network
 * setup > IP control > Authentication = "Pre-Shared Key" y ahi mismo la
 * clave; y "Simple IP control" = On para poder encenderla por red.
 *
 * El PSK viaja en cada peticion como cabecera: NUNCA se escribe en logs ni
 * en mensajes de error (misma regla que el token de Glasshouse).
 */

export type BraviaService = 'system' | 'audio' | 'avContent' | 'appControl' | 'video';

const REQ_TIMEOUT_MS = 8_000;

/** Error hablado; nunca incluye la PSK ni el cuerpo de la peticion. */
export class BraviaError extends Error {}

export interface BraviaDeps {
  fetchImpl?: typeof fetch;
}

let nextId = 1;

/**
 * Llamada JSON-RPC a la Bravia. Error de red, HTTP o de la propia API ->
 * BraviaError en castellano; un error de la tele NO se reintenta (es
 * respuesta), y un fallo de red tampoco desde aqui (lo decide el llamador).
 */
export async function braviaRequest(
  host: string,
  psk: string,
  service: BraviaService,
  method: string,
  params: unknown[] = [],
  deps: BraviaDeps = {},
): Promise<unknown> {
  const doFetch = deps.fetchImpl ?? fetch;
  const id = nextId++;
  let res: Response;
  try {
    res = await doFetch(`http://${host}/sony/${service}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-PSK': psk },
      body: JSON.stringify({ method, params, id, version: '1.0' }),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
  } catch {
    throw new BraviaError('No llego a la tele Sony: ¿esta encendida y en la misma red que el PC?');
  }
  if (res.status === 401 || res.status === 403) {
    throw new BraviaError(
      'La tele Sony ha rechazado la clave (PSK): revisa en la tele Ajustes > Red > Home network setup > IP control > Pre-Shared Key.',
    );
  }
  if (!res.ok) throw new BraviaError(`La tele Sony ha respondido con un error (${res.status}).`);
  let data: { result?: unknown; error?: unknown };
  try {
    data = (await res.json()) as { result?: unknown; error?: unknown };
  } catch {
    throw new BraviaError('La tele Sony ha respondido algo que no entiendo.');
  }
  if (data.error !== undefined) {
    // El error de la API es un [codigo, mensaje]; el mensaje viene de la tele,
    // no es nuestro: se da el codigo, que basta para diagnosticar.
    const code = Array.isArray(data.error) ? data.error[0] : data.error;
    throw new BraviaError(`La tele Sony dice que no puede (${String(code)}).`);
  }
  return data.result;
}

/** Estado de encendido: 'active' | 'standby'. */
export async function braviaPowerStatus(
  host: string,
  psk: string,
  deps: BraviaDeps = {},
): Promise<string> {
  const result = (await braviaRequest(host, psk, 'system', 'getPowerStatus', [], deps)) as {
    status?: string;
  }[];
  return result?.[0]?.status ?? 'desconocido';
}

/** Apaga (standby). Encender es por Wake-on-LAN (wol.ts) con "Remote start". */
export async function braviaPowerOff(
  host: string,
  psk: string,
  deps: BraviaDeps = {},
): Promise<void> {
  await braviaRequest(host, psk, 'system', 'setPowerStatus', [{ status: false }], deps);
}

export interface BraviaVolume {
  volume: number;
  mute: boolean;
  /** Volumen maximo que admite esta tele (para /tv volumen a N). */
  maxVolume: number;
}

/** Volumen y silencio del altavoz activo. */
export async function braviaVolume(
  host: string,
  psk: string,
  deps: BraviaDeps = {},
): Promise<BraviaVolume> {
  const result = (await braviaRequest(host, psk, 'audio', 'getVolumeInformation', [], deps)) as {
    target?: string;
    volume?: number;
    mute?: boolean;
    maxVolume?: number;
  }[][];
  const speaker = (result?.[0] ?? []).find((v) => v.target === 'speaker') ?? result?.[0]?.[0];
  return {
    volume: speaker?.volume ?? 0,
    mute: speaker?.mute ?? false,
    maxVolume: speaker?.maxVolume ?? 100,
  };
}

export async function braviaSetVolume(
  host: string,
  psk: string,
  volume: number,
  deps: BraviaDeps = {},
): Promise<void> {
  const target = Math.max(0, Math.min(100, Math.round(volume)));
  await braviaRequest(
    host,
    psk,
    'audio',
    'setAudioVolume',
    [{ target: 'speaker', volume: String(target) }],
    deps,
  );
}

export async function braviaSetMute(
  host: string,
  psk: string,
  mute: boolean,
  deps: BraviaDeps = {},
): Promise<void> {
  await braviaRequest(host, psk, 'audio', 'setAudioMute', [{ status: mute }], deps);
}

/** Que esta sonando/viendo ahora (titulo, fuente), si la tele lo sabe. */
export async function braviaPlaying(
  host: string,
  psk: string,
  deps: BraviaDeps = {},
): Promise<{ title?: string; source?: string }> {
  const result = (await braviaRequest(
    host,
    psk,
    'avContent',
    'getPlayingContentInfo',
    [],
    deps,
  )) as {
    title?: string;
    source?: string;
  }[];
  const info = result?.[0] ?? {};
  return {
    ...(info.title ? { title: info.title } : {}),
    ...(info.source ? { source: info.source } : {}),
  };
}

/** Nombre y modelo (para `pa tv setup-sony`: confirmar que hablamos con ella). */
export async function braviaSystemInfo(
  host: string,
  psk: string,
  deps: BraviaDeps = {},
): Promise<{ name?: string; model?: string }> {
  const result = (await braviaRequest(host, psk, 'system', 'getSystemInformation', [], deps)) as {
    name?: string;
    model?: string;
  }[];
  const info = result?.[0] ?? {};
  return {
    ...(info.name ? { name: info.name } : {}),
    ...(info.model ? { model: info.model } : {}),
  };
}

/** Letra final del modelo Sony -> ano de la gama (C=2015 ... L=2023). Estimacion. */
const SONY_YEAR_BY_LETTER: Record<string, number> = {
  C: 2015,
  D: 2016,
  E: 2017,
  F: 2018,
  G: 2019,
  H: 2020,
  J: 2021,
  K: 2022,
  L: 2023,
};

/** Año aproximado de una Bravia por la letra del modelo (XR-55X90J -> 2021). */
export function sonyModelYear(model: string): number | undefined {
  const m = /([A-L])(?:[ .-]?A?[EPB]?)?$/i.exec(model.trim());
  const letter = m?.[1]?.toUpperCase();
  return letter ? SONY_YEAR_BY_LETTER[letter] : undefined;
}

/** «2021 aprox.» o «año por confirmar» (la letra del modelo es una estimación). */
export function sonyModelYearText(model: string): string {
  const year = sonyModelYear(model);
  return year ? `${year} aprox.` : 'año por confirmar';
}

/** Metodos REST que usa Asistenta (todos de la v1.0, Bravia 2013+). */
export const BRAVIA_METHODS_USED = [
  { service: 'system', method: 'getPowerStatus' },
  { service: 'system', method: 'setPowerStatus' },
  { service: 'audio', method: 'getVolumeInformation' },
  { service: 'audio', method: 'setAudioVolume' },
  { service: 'audio', method: 'setAudioMute' },
  { service: 'avContent', method: 'getPlayingContentInfo' },
  { service: 'system', method: 'getSystemInformation' },
] as const;

/**
 * Valida contra la tele real los metodos que Asistenta necesita (en setup,
 * tele ya con PSK). Los de escritura NO se prueban de verdad: se llama a su
 * version de lectura equivalente... salvo set*, que se dan por buenos si la
 * tele contesta getSystemInformation con su generacion de API.
 */
export async function braviaValidateMethods(
  host: string,
  psk: string,
  deps: BraviaDeps = {},
): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [];
  const failed: string[] = [];
  const checks: { name: string; run: () => Promise<unknown> }[] = [
    { name: 'getSystemInformation', run: () => braviaSystemInfo(host, psk, deps) },
    { name: 'getPowerStatus', run: () => braviaPowerStatus(host, psk, deps) },
    { name: 'getVolumeInformation', run: () => braviaVolume(host, psk, deps) },
    { name: 'getPlayingContentInfo', run: () => braviaPlaying(host, psk, deps) },
  ];
  for (const check of checks) {
    try {
      await check.run();
      ok.push(check.name);
    } catch {
      failed.push(check.name);
    }
  }
  return { ok, failed };
}

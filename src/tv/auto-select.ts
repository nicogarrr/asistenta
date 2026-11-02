/**
 * Tele activa automatica al cambiar de casa/red.
 *
 * El PC viaja entre dos casas (una con LG, otra con Sony). Al llegar, la tele
 * activa guardada NO responde (esta en la otra red). Este modulo:
 *   1. prueba si la activa responde (TCP barato, nada visible en pantalla);
 *   2. si no, descubre por SSDP que teles CONOCIDAS (registro tv:tvs) hay
 *      encendidas en esta red, reconociendolas por IP, por MAC (tabla de
 *      vecinos: la IP puede cambiar con el DHCP de cada casa) o por UUID SSDP;
 *   3. si hay exactamente una, la pone activa en el vault y sigue el comando.
 * Cero re-emparejamiento: las claves de cada tele ya estan guardadas.
 *
 * Solo lectura de red: ningun paso muestra nada en la tele (regla LG).
 */

import { type DiscoveredTv, discoverWebOsTvs } from './discover.js';
import { findTv, type KnownTv, parseRegistry, withLegacyTv } from './registry.js';

export const TV_REGISTRY_KEY = 'tv:tvs';

/** Negativo cacheado: sin ninguna tele conocida a la vista, no re-escanear en cada orden. */
const MISS_CACHE_MS = 60_000;

export interface AutoSelectDeps {
  vaultGet: (key: string) => Promise<string | undefined>;
  vaultSetMany: (entries: Record<string, string>) => Promise<void>;
  discover?: () => Promise<DiscoveredTv[]>;
  /** TCP: ¿hay algo escuchando en host:port? (inyectable en tests). */
  tcpOpen?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  /** MAC de una IP en la tabla de vecinos (inyectable en tests). */
  macOf?: (ip: string) => Promise<string | null>;
  now?: () => number;
}

let lastMiss = 0;

/** Puerto que delata a la tele en su red: SSAP cifrado en LG, REST en Sony. */
export function tvPort(brand: 'lg' | 'sony' | 'roku'): number {
  if (brand === 'roku') return 8060;
  return brand === 'sony' ? 80 : 3001;
}

async function defaultTcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function normMac(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const m = mac.trim().toLowerCase().replace(/-/g, ':');
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m) ? m : null;
}

/**
 * Que tele del registro es esta descubierta: por IP exacta, por UUID SSDP o
 * por MAC (cada casa tiene su DHCP y la IP puede no ser la guardada).
 */
export function matchKnownTv(
  found: DiscoveredTv,
  known: readonly KnownTv[],
  mac: string | null,
): KnownTv | undefined {
  const byIp = findTv(known, found.ip);
  if (byIp) return byIp;
  const uuid = found.usn?.match(/uuid:([^:]+)/)?.[1]?.toLowerCase();
  if (uuid) {
    const byUuid = known.find((t) => t.uuid?.toLowerCase() === uuid);
    if (byUuid) return byUuid;
  }
  const macN = normMac(mac);
  if (macN) return known.find((t) => normMac(t.mac) === macN);
  return undefined;
}

export interface EnsureResult {
  /** Tele activa tras la pasada (la de siempre o la recien cambiada). */
  host?: string;
  brand?: 'lg' | 'sony' | 'roku';
  /** Se ha cambiado la activa a esta (para avisar al usuario). */
  switchedTo?: KnownTv;
  /** Por que no hay tele usable, en castellano. */
  reason?: string;
}

/**
 * Garantiza que la tele activa es una que responde en ESTA red, cambiandola
 * en el vault si hace falta. Idempotente y silenciosa cuando la activa ya
 * responde (el caso normal dentro de casa).
 */
export async function ensureActiveTv(deps: AutoSelectDeps): Promise<EnsureResult> {
  const now = deps.now ?? Date.now;
  const host = await deps.vaultGet('tv:host');
  const rawBrand = await deps.vaultGet('tv:activeBrand');
  const brand = rawBrand === 'sony' ? 'sony' : rawBrand === 'roku' ? 'roku' : 'lg';
  if (!host) return { reason: 'no hay ninguna tele emparejada' };
  const tcpOpen = deps.tcpOpen ?? defaultTcpOpen;

  // Caso normal: la activa responde en esta red. Nada que hacer.
  if (await tcpOpen(host, tvPort(brand), 900)) return { host, brand };

  // Miss cacheado: ni activa ni ninguna conocida hace un momento.
  if (now() - lastMiss < MISS_CACHE_MS) {
    return { reason: 'la tele activa no responde en esta red' };
  }

  // Registro efectivo: tv:tvs mas la tele de las claves sueltas si se
  // emparejo antes de que existiera el registro (migracion sin escribir).
  const known = withLegacyTv(parseRegistry(await deps.vaultGet(TV_REGISTRY_KEY)), {
    host,
    clientKey: await deps.vaultGet('tv:clientKey'),
    secure: await deps.vaultGet('tv:secure'),
    mac: await deps.vaultGet('tv:mac'),
    brand: await deps.vaultGet('tv:activeBrand'),
  });
  // Sin teles conocidas, descubrir no puede casar nada: no se escanea (y no
  // se espera el SSDP). Caso de una sola tele de siempre.
  if (known.length === 0) {
    lastMiss = now();
    return { reason: 'la tele activa no responde en esta red' };
  }
  const discover =
    deps.discover ?? (() => discoverWebOsTvs({ waitMs: 2_500, probeGlasshouse: false }));
  let found: DiscoveredTv[] = [];
  try {
    found = await discover();
  } catch {
    found = [];
  }
  const macOf = deps.macOf ?? (async () => null);
  const matches: { tv: KnownTv; found: DiscoveredTv }[] = [];
  for (const f of found) {
    const tv = matchKnownTv(f, known, await macOf(f.ip));
    if (tv && !matches.some((m) => m.tv.host === tv.host)) matches.push({ tv, found: f });
  }

  if (matches.length === 0) {
    lastMiss = now();
    return {
      reason:
        'la tele activa no responde y no veo ninguna tele tuya encendida en esta red (¿esta apagada del todo?)',
    };
  }
  if (matches.length > 1) {
    return {
      reason: `veo ${matches.length} teles tuyas encendidas en esta red: di «pa tv usar <ip>» para elegir`,
    };
  }

  const [match] = matches;
  if (!match) return { reason: 'la tele activa no responde en esta red' };
  const tv = match.tv;
  // La IP pudo cambiar por DHCP: se guarda la vista ahora, no la vieja.
  const newHost = match.found.ip;
  await deps.vaultSetMany({
    'tv:host': newHost,
    'tv:activeBrand': tv.brand ?? 'lg',
    ...(tv.brand === 'sony' || tv.brand === 'roku'
      ? {}
      : { 'tv:clientKey': tv.clientKey, 'tv:secure': tv.secure }),
    ...(tv.mac ? { 'tv:mac': tv.mac } : {}),
    // La IP nueva entra al registro para la proxima vez.
    [TV_REGISTRY_KEY]: JSON.stringify(
      known.map((t) => (t.host === tv.host && t.host !== newHost ? { ...t, host: newHost } : t)),
    ),
  });
  return { host: newHost, brand: tv.brand ?? 'lg', switchedTo: { ...tv, host: newHost } };
}

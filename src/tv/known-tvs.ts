/**
 * Teles conocidas desde el vault: el registro (tv:tvs) mas la tele de las
 * claves sueltas de siempre. Lo usan la CLI (`pa tv ...`) y la tool de la tele.
 */

import type { DiscoveredTv } from './discover.js';
import { readNeighborMac } from './neighbor-mac.js';
import {
  applyMoves,
  findMovedTvs,
  type KnownTv,
  macKey,
  parseRegistry,
  registryToJson,
  upsertTv,
  withLegacyTv,
} from './registry.js';

export const TV_HOST_KEY = 'tv:host';
export const TV_REGISTRY_KEY = 'tv:tvs';
export const TV_ACTIVE_BRAND = 'tv:activeBrand';
export const TV_CLIENT_KEY = 'tv:clientKey';
export const TV_SECURE_KEY = 'tv:secure';
export const TV_MAC_KEY = 'tv:mac';

/**
 * Registro efectivo: tv:tvs mas la tele de las claves sueltas si se emparejo
 * antes de que existiera el registro (migracion sin escribir nada).
 */
export async function loadKnownTvs(): Promise<KnownTv[]> {
  const { vaultGet } = await import('../vault.js');
  return withLegacyTv(parseRegistry(await vaultGet(TV_REGISTRY_KEY)), {
    host: await vaultGet(TV_HOST_KEY),
    clientKey: await vaultGet(TV_CLIENT_KEY),
    secure: await vaultGet(TV_SECURE_KEY),
    mac: await vaultGet(TV_MAC_KEY),
    brand: await vaultGet(TV_ACTIVE_BRAND),
  });
}

/**
 * Teles guardadas que el router ha cambiado de IP: se reconocen por MAC (la
 * tabla de vecinos del PC, que la respuesta SSDP acaba de rellenar) o por el
 * UUID UPnP. Actualiza el registro y, si era la activa, tv:host. Devuelve los
 * cambios hechos (vacio = nada que tocar, y entonces no escribe).
 */
export async function relocateMovedTvs(
  found: readonly DiscoveredTv[],
  deps: { neighborMac?: (ip: string) => Promise<string | null> } = {},
): Promise<Array<{ tv: KnownTv; from: string; to: string }>> {
  const known = await loadKnownTvs();
  const wantsMac = known.some((t) => macKey(t.mac).length === 12);
  const neighborMac = deps.neighborMac ?? ((h: string) => readNeighborMac(h));
  const seen = await Promise.all(
    found.map(async (f) => ({
      ip: f.ip,
      uuid: f.uuid ?? null,
      mac:
        wantsMac && !known.some((t) => t.host === f.ip)
          ? await neighborMac(f.ip).catch(() => null)
          : null,
    })),
  );
  const moves = findMovedTvs(known, seen);
  if (moves.length === 0) return [];
  const { vaultGet, vaultSet, vaultSetMany } = await import('../vault.js');
  await vaultSet(TV_REGISTRY_KEY, registryToJson(applyMoves(known, moves)));
  const active = await vaultGet(TV_HOST_KEY);
  const activeMove = moves.find((m) => m.from === active);
  if (activeMove) await vaultSetMany({ [TV_HOST_KEY]: activeMove.to });
  return moves;
}

/**
 * La tele (no la activa) se volvio a emparejar durante una orden: la clave
 * nueva va a SU entrada del registro, y a tv:clientKey solo si es la activa.
 */
export async function saveTvClientKey(host: string, key: string): Promise<void> {
  const { vaultGet, vaultSet } = await import('../vault.js');
  const list = await loadKnownTvs();
  const tv = list.find((t) => t.host === host);
  if (tv)
    await vaultSet(TV_REGISTRY_KEY, registryToJson(upsertTv(list, { ...tv, clientKey: key })));
  if ((await vaultGet(TV_HOST_KEY)) === host) await vaultSet(TV_CLIENT_KEY, key);
}

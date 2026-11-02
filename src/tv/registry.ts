/**
 * Registro de teles conocidas (vault `tv:tvs`): una entrada por tele
 * emparejada, para que `pa tv usar <ip>` cambie la activa sin re-emparejar.
 *
 * La tele ACTIVA sigue viviendo en las claves sueltas de siempre
 * (tv:host/tv:clientKey/tv:secure): todos los comandos existentes la leen de
 * ahi sin tocarlos. Este modulo solo parsea y ordena el JSON del registro.
 */

export interface KnownTv {
  host: string;
  /** Marca; las entradas viejas sin brand son LG (era la unica soportada). */
  brand?: 'lg' | 'sony';
  /** Nombre legible (del XML UPnP o el que le ponga el dueno). */
  name?: string;
  model?: string;
  clientKey: string;
  /** '1' = wss (defecto); '0' = pairing por ws 3000, downgrade prohibido. */
  secure: '1' | '0';
  mac?: string;
  /** ISO de cuando se emparejo. */
  pairedAt?: string;
}

/** Lee el JSON del vault; lo corrupto o con otra forma cuenta como vacio. */
export function parseRegistry(raw: string | undefined | null): KnownTv[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    const out: KnownTv[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const t = item as Record<string, unknown>;
      if (typeof t.host !== 'string' || !t.host.trim()) continue;
      const brand = t.brand === 'sony' ? 'sony' : 'lg';
      // La clave de emparejamiento solo aplica a LG (Sony usa PSK por host en el vault).
      if (brand === 'lg' && (typeof t.clientKey !== 'string' || !t.clientKey)) continue;
      out.push({
        host: t.host.trim(),
        brand,
        clientKey: typeof t.clientKey === 'string' ? t.clientKey : '',
        ...(typeof t.name === 'string' && t.name.trim() ? { name: t.name.trim() } : {}),
        ...(typeof t.model === 'string' && t.model.trim() ? { model: t.model.trim() } : {}),
        secure: t.secure === '0' ? '0' : '1',
        ...(typeof t.mac === 'string' && t.mac.trim() ? { mac: t.mac.trim() } : {}),
        ...(typeof t.pairedAt === 'string' ? { pairedAt: t.pairedAt } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Inserta o actualiza por host; devuelve lista nueva ordenada por host. */
export function upsertTv(list: readonly KnownTv[], tv: KnownTv): KnownTv[] {
  const rest = list.filter((t) => t.host !== tv.host);
  return [...rest, tv].sort((a, b) => a.host.localeCompare(b.host, 'es', { numeric: true }));
}

/** Busca por IP exacta o por nombre (sin mayusculas). */
export function findTv(list: readonly KnownTv[], hostOrName: string): KnownTv | undefined {
  const want = hostOrName.trim().toLowerCase();
  return (
    list.find((t) => t.host === hostOrName.trim()) ??
    list.find((t) => t.name?.toLowerCase() === want)
  );
}

export function registryToJson(list: readonly KnownTv[]): string {
  return JSON.stringify(list);
}

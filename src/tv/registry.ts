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
  /** UUID SSDP (usn): identidad estable aunque cambie la IP. */
  uuid?: string;
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
        ...(typeof t.uuid === 'string' && t.uuid.trim() ? { uuid: t.uuid.trim() } : {}),
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

/**
 * Nombre comparable: sin mayusculas, sin tildes, sin «[LG]» delante y con los
 * espacios juntos. «Salón» y «salon» son la misma tele.
 */
export function normalizeTvName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Busca por IP exacta o por nombre (sin mayusculas ni tildes). */
export function findTv(list: readonly KnownTv[], hostOrName: string): KnownTv | undefined {
  const want = normalizeTvName(hostOrName);
  return (
    list.find((t) => t.host === hostOrName.trim()) ??
    list.find((t) => t.name !== undefined && normalizeTvName(t.name) === want)
  );
}

/** Tele emparejada antes del registro (solo las claves sueltas tv:host/tv:clientKey/...). */
export interface LegacyTvKeys {
  host?: string | null | undefined;
  clientKey?: string | null | undefined;
  secure?: string | null | undefined;
  mac?: string | null | undefined;
  brand?: string | null | undefined;
}

/**
 * Registro efectivo: el guardado mas la tele de las claves sueltas si aun no
 * esta en el (quien emparejo antes de que existiera el registro). No escribe
 * nada: con una sola tele de antes, el vault queda byte a byte igual.
 */
export function withLegacyTv(list: readonly KnownTv[], legacy: LegacyTvKeys): KnownTv[] {
  const host = legacy.host?.trim();
  if (!host || list.some((t) => t.host === host)) return [...list];
  if (legacy.brand === 'sony')
    return upsertTv(list, { host, brand: 'sony', clientKey: '', secure: '1' });
  if (!legacy.clientKey) return [...list];
  return upsertTv(list, {
    host,
    brand: 'lg',
    clientKey: legacy.clientKey,
    secure: legacy.secure === '0' ? '0' : '1',
    ...(legacy.mac?.trim() ? { mac: legacy.mac.trim() } : {}),
  });
}

/** MAC comparable: hex en minusculas sin separadores. */
export function macKey(mac: string | null | undefined): string {
  return (mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

export interface TvMove {
  tv: KnownTv;
  from: string;
  to: string;
}

/**
 * Teles guardadas que ahora contestan en otra IP (el router les dio otra por
 * DHCP). Se reconocen por su MAC o por su UUID UPnP, nunca por el nombre.
 * Una IP nueva que ya es de otra tele guardada no se toma.
 */
export function findMovedTvs(
  known: readonly KnownTv[],
  seen: ReadonlyArray<{ ip: string; mac?: string | null; uuid?: string | null }>,
): TvMove[] {
  const moves: TvMove[] = [];
  const taken = new Set(known.map((t) => t.host));
  for (const tv of known) {
    const mac = macKey(tv.mac);
    const hit = seen.find(
      (s) =>
        s.ip !== tv.host &&
        ((mac.length === 12 && macKey(s.mac) === mac) ||
          (tv.uuid !== undefined &&
            s.uuid !== undefined &&
            s.uuid !== null &&
            s.uuid.toLowerCase() === tv.uuid.toLowerCase())),
    );
    // Si la tele sigue contestando en su IP de siempre, no se ha movido.
    if (!hit || seen.some((s) => s.ip === tv.host) || taken.has(hit.ip)) continue;
    moves.push({ tv, from: tv.host, to: hit.ip });
    taken.add(hit.ip);
  }
  return moves;
}

/** Aplica los cambios de IP al registro (mismo orden y forma que upsertTv). */
export function applyMoves(list: readonly KnownTv[], moves: readonly TvMove[]): KnownTv[] {
  let out = [...list];
  for (const m of moves) {
    out = upsertTv(
      out.filter((t) => t.host !== m.from),
      { ...m.tv, host: m.to },
    );
  }
  return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: se rechazan justo los controles
const NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Nombre que pone el dueño («salón»): corto, sin controles y que no sea una IP. */
export function validateTvName(raw: string): string {
  const name = raw.replace(NAME_CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Pon un nombre, por ejemplo: pa tv nombre 192.168.1.20 salón');
  if (name.length > 40) throw new Error('Nombre demasiado largo (máx. 40 caracteres).');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) throw new Error('El nombre no puede ser una IP.');
  return name;
}

export function registryToJson(list: readonly KnownTv[]): string {
  return JSON.stringify(list);
}

/**
 * Descubrimiento de teles LG webOS en la LAN (SSDP).
 *
 * Como funciona: se manda un M-SEARCH al multicast 239.255.255.250:1900 y
 * cada aparato UPnP de la red contesta con una cabecera HTTPU. Las webOS se
 * reconocen por la cabecera SERVER ("WebOS"/"LG"); el LOCATION apunta a su
 * descripcion XML, de donde salen el nombre que ve el dueno y el modelo.
 * Ademas se prueba el puerto 8080 de cada una: si responde la API de
 * Glasshouse, esa tele esta rooteada y se puede manejar sin emparejar.
 *
 * Todo es LECTURA y nada aparece en pantalla: el M-SEARCH es el mismo
 * paquete que manda Windows al abrir "Red". No toca la tele.
 */

import { assertTvHost } from './lgtv.js';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
/** Espera total recogiendo respuestas; las teles de casa contestan en <1s. */
export const DISCOVER_WAIT_MS = 3_000;
const LOCATION_TIMEOUT_MS = 1_500;
const GLASSHOUSE_TIMEOUT_MS = 800;

export interface SsdpResponse {
  location?: string;
  server?: string;
  usn?: string;
  st?: string;
}

/** Parsea una respuesta HTTPU de SSDP; null si no trae cabeceras. */
export function parseSsdpResponse(text: string): SsdpResponse | null {
  const headers = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  if (headers.size === 0) return null;
  const out: SsdpResponse = {};
  const location = headers.get('location');
  const server = headers.get('server');
  const usn = headers.get('usn');
  const st = headers.get('st');
  if (location) out.location = location;
  if (server) out.server = server;
  if (usn) out.usn = usn;
  if (st) out.st = st;
  return out;
}

/** Nombre del aparato en su XML UPnP (best-effort, sin parser XML). */
export function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml);
  const value = m?.[1]?.trim();
  return value ? value : undefined;
}

export type TvBrand = 'lg' | 'sony' | 'roku' | 'samsung';

/** Es una tele Samsung (no un móvil ni una barra): «[TV]» en el nombre, su ST de mando o un modelo de tele. */
export function isSamsungTv(info: {
  manufacturer?: string;
  friendlyName?: string;
  modelName?: string;
  st?: string;
}): boolean {
  if (/RemoteControlReceiver/i.test(info.st ?? '') && /samsung/i.test(info.manufacturer ?? '')) {
    return true;
  }
  if (!/samsung/i.test(info.manufacturer ?? '')) return false;
  return (
    /^\s*\[TV\]/i.test(info.friendlyName ?? '') ||
    /^(UE|QE|UN|QN|GQ|GU|LS)\d/i.test(info.modelName ?? '')
  );
}

/** Es un Roku (o una tele con Roku dentro): su SERVER o su fabricante lo dicen. */
export function isRoku(info: { server?: string; manufacturer?: string; st?: string }): boolean {
  if (/^roku:ecp$/i.test(info.st ?? '')) return true;
  if (/\broku\//i.test(info.server ?? '')) return true;
  return /^roku/i.test(info.manufacturer ?? '');
}

/** Es una Sony Bravia: el fabricante o el modelo lo dicen (ScalarWebAPI la delata en SSDP). */
export function isSonyBravia(info: {
  server?: string;
  modelName?: string;
  friendlyName?: string;
  manufacturer?: string;
  st?: string;
  usn?: string;
}): boolean {
  if (/scalarwebapi/i.test(info.st ?? '') || /scalarwebapi/i.test(info.usn ?? '')) return true;
  if (/sony/i.test(info.manufacturer ?? '')) return true;
  return /bravia/i.test(info.modelName ?? '') || /bravia/i.test(info.friendlyName ?? '');
}

/** Es una LG webOS: lo dice su SERVER o su descripcion. */
export function isLgWebOsTv(info: {
  server?: string;
  modelName?: string;
  friendlyName?: string;
  manufacturer?: string;
}): boolean {
  if (/webos/i.test(info.server ?? '')) return true;
  if (/webos/i.test(info.modelName ?? '')) return true;
  return /lg/i.test(info.manufacturer ?? '') && /webos/i.test(info.friendlyName ?? '');
}

export interface DiscoveredTv {
  ip: string;
  brand: TvBrand;
  /** Nombre que la tele ensena en Ajustes (del XML UPnP), si se pudo leer. */
  name?: string;
  model?: string;
  server?: string;
  st?: string;
  usn?: string;
  /** uuid del USN SSDP: identidad estable de la tele aunque cambie su IP. */
  uuid?: string;
  /** true si responde la API de Glasshouse (:8080): tele rooteada, control total. */
  glasshouse: boolean;
}

/** Socket UDP minimo (inyectable en tests). */
export interface UdpLike {
  send(msg: Buffer, port: number, addr: string, cb?: (err?: Error) => void): void;
  on(event: 'message', cb: (msg: Buffer, rinfo: { address: string }) => void): void;
  close(): void;
}

export interface DiscoverDeps {
  socket?: UdpLike;
  fetchImpl?: typeof fetch;
  waitMs?: number;
  /** false en tests o cuando no interesa el sondeo :8080. */
  probeGlasshouse?: boolean;
  now?: () => number;
}

/** Solo aparatos de la red local: una respuesta desde una IP publica se ignora. */
export function isLanAddress(ip: string): boolean {
  try {
    assertTvHost(ip);
    return true;
  } catch {
    return false;
  }
}

/**
 * El XML solo se pide al propio aparato que contesto (http y su misma IP):
 * un LOCATION que apunta a otra maquina o a internet no se sigue.
 */
export function sameDeviceLocation(location: string, ip: string): boolean {
  try {
    const url = new URL(location);
    return url.protocol === 'http:' && url.hostname === ip && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** UUID del USN («uuid:xxxx::urn:...»), en minusculas. */
export function uuidFromUsn(usn: string | undefined): string | undefined {
  const m = /uuid:([0-9a-z-]{8,64})/i.exec(usn ?? '');
  return m?.[1]?.toLowerCase();
}

function msearch(st: string): Buffer {
  return Buffer.from(
    `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`,
  );
}

async function fetchXml(url: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(LOCATION_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`xml ${res.status}`);
  return res.text();
}

async function probeOne(ip: string, fetchImpl: typeof fetch): Promise<{ glasshouse: boolean }> {
  try {
    const res = await fetchImpl(`http://${ip}:8080/api/caps`, {
      signal: AbortSignal.timeout(GLASSHOUSE_TIMEOUT_MS),
    });
    return { glasshouse: res.ok };
  } catch {
    return { glasshouse: false };
  }
}

/**
 * Busca teles LG webOS en la red. Devuelve las encontradas (sin duplicar por
 * IP, ordenadas por IP). Fallos de red = lista vacia, nunca excepcion.
 */
export async function discoverWebOsTvs(deps: DiscoverDeps = {}): Promise<DiscoveredTv[]> {
  const waitMs = Math.max(500, Math.min(15_000, Math.round(deps.waitMs ?? DISCOVER_WAIT_MS)));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const byIp = new Map<string, DiscoveredTv>();
  const locations = new Map<string, string>();

  let created = deps.socket;
  if (!created) {
    const { createSocket } = await import('node:dgram');
    created = createSocket('udp4') as unknown as UdpLike;
  }
  const socket: UdpLike = created;

  await new Promise<void>((resolve) => {
    socket.on('message', (msg, rinfo) => {
      const parsed = parseSsdpResponse(msg.toString('utf8'));
      if (!parsed || !rinfo.address || !isLanAddress(rinfo.address)) return;
      const prev = byIp.get(rinfo.address);
      // Cualquier respuesta SSDP guarda al aparato; la marca se decide con su XML.
      byIp.set(rinfo.address, {
        ip: rinfo.address,
        brand: prev?.brand ?? 'lg',
        ...((parsed.server ?? prev?.server) ? { server: parsed.server ?? prev?.server ?? '' } : {}),
        ...((parsed.st ?? prev?.st) ? { st: parsed.st ?? prev?.st ?? '' } : {}),
        ...((parsed.usn ?? prev?.usn) ? { usn: parsed.usn ?? prev?.usn ?? '' } : {}),
        glasshouse: prev?.glasshouse ?? false,
      });
      if (parsed.location && sameDeviceLocation(parsed.location, rinfo.address))
        locations.set(rinfo.address, parsed.location);
    });
    const sendBoth = () => {
      for (const st of [
        'ssdp:all',
        'urn:dial-multiscreen-org:service:dial:1',
        'urn:schemas-sony-com:service:ScalarWebAPI:1',
        'roku:ecp',
        'urn:samsung.com:device:RemoteControlReceiver:1',
      ]) {
        try {
          socket.send(msearch(st), SSDP_PORT, SSDP_ADDR, () => {});
        } catch {
          // Interfaz caida o sin multicast: se recoge lo que haya.
        }
      }
    };
    sendBoth();
    // Segunda ronda a mitad de espera por si el primero se pierde en wifi.
    const half = setTimeout(sendBoth, Math.floor(waitMs / 2));
    setTimeout(() => {
      clearTimeout(half);
      try {
        socket.close();
      } catch {
        // Ya cerrado.
      }
      resolve();
    }, waitMs);
  });

  // Fase 2: XML de cada LOCATION para nombre/modelo y filtro webOS.
  const out: DiscoveredTv[] = [];
  for (const [ip, tv] of byIp) {
    const location = locations.get(ip);
    let name: string | undefined;
    let model: string | undefined;
    let manufacturer: string | undefined;
    if (location) {
      try {
        const xml = await fetchXml(location, fetchImpl);
        name = xmlTag(xml, 'friendlyName');
        model = xmlTag(xml, 'modelName');
        manufacturer = xmlTag(xml, 'manufacturer');
      } catch {
        // Sin XML: nos quedamos con el SERVER.
      }
    }
    const info = {
      server: tv.server,
      modelName: model,
      friendlyName: name,
      manufacturer,
      st: tv.st,
      usn: tv.usn,
    };
    const brand: TvBrand = isSonyBravia(info)
      ? 'sony'
      : isLgWebOsTv(info)
        ? 'lg'
        : isRoku(info)
          ? 'roku'
          : isSamsungTv(info)
            ? 'samsung'
            : (undefined as never);
    if (!brand) continue;
    const uuid = tv.uuid ?? uuidFromUsn(tv.usn);
    out.push({
      ip,
      brand,
      ...(name ? { name } : {}),
      ...(model ? { model } : {}),
      ...(tv.server ? { server: tv.server } : {}),
      ...(tv.usn ? { usn: tv.usn } : {}),
      ...(uuid ? { uuid } : {}),
      glasshouse: tv.glasshouse,
    });
  }

  // Fase 3 (opcional): sondeo Glasshouse :8080 (solo LG rooteadas), en paralelo.
  if (deps.probeGlasshouse !== false) {
    await Promise.all(
      out.map(async (tv) => {
        if (tv.brand === 'lg') tv.glasshouse = (await probeOne(tv.ip, fetchImpl)).glasshouse;
      }),
    );
  }

  return out.sort((a, b) => a.ip.localeCompare(b.ip, 'es', { numeric: true }));
}

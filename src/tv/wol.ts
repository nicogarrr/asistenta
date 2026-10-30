/**
 * Wake-on-LAN para la tele LG: con la tele apagada del todo no hay SSAP ni
 * Glasshouse que escuchen, asi que "enciende la tele" solo puede llegar como
 * paquete magico UDP a la MAC de su tarjeta de red (webOS: Ajustes > General >
 * Dispositivos > "Encender con Wi-Fi/movil" o "Mobile TV On" activado).
 *
 * La MAC vive en el vault (tv:mac). `pa tv setup` intenta leerla de la propia
 * tele al emparejar y `pa tv mac <MAC>` la fija a mano. Sin MAC no se envia
 * nada: el encendido sigue como hasta ahora.
 *
 * El paquete va a 255.255.255.255 y al broadcast /24 de la IP de la tele: en
 * Windows el broadcast global sale solo por la interfaz por defecto.
 */
import { createSocket } from 'node:dgram';

const MAC_RE =
  /^([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})[:-]?([0-9a-f]{2})$/i;

/** MAC normalizada aa:bb:cc:dd:ee:ff o error en castellano. */
export function parseMac(raw: string): string {
  const m = MAC_RE.exec(raw.trim());
  if (!m) {
    throw new Error(
      'MAC de la tele no valida: usa el formato AA:BB:CC:DD:EE:FF (la ves en la tele en Ajustes > General > Acerca de esta TV).',
    );
  }
  const mac = m.slice(1, 7).join(':').toLowerCase();
  if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') {
    throw new Error('MAC de la tele no valida: no puede ser todo ceros ni todo FF.');
  }
  return mac;
}

const MAC_DONDE =
  'La MAC real de la tele está en la tele en Ajustes > General > Acerca de este TV (o en la lista de dispositivos del router); con la tele encendida y emparejada, «pa tv mac auto» la lee sola.';

/**
 * MAC para guardar como la de la tele: `parseMac` y, además, rechaza las MAC
 * multicast (bit 0 del primer byte: «69:e3:…» es el ID de una app IPTV, no
 * una tarjeta de red) y avisa, sin rechazar, de las administradas localmente
 * (bit 1: MAC aleatoria de wifi). El envío del paquete mágico no cambia.
 */
export function validateTvMac(raw: string): { mac: string; warning: string | null } {
  let mac: string;
  try {
    mac = parseMac(raw);
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.message : String(err)} ${MAC_DONDE}`);
  }
  const first = Number.parseInt(mac.slice(0, 2), 16);
  if (first & 0x01) {
    throw new Error(
      `«${mac}» no puede ser la MAC de la tele: es una dirección multicast (el primer byte es impar), no la de una tarjeta de red. Seguramente es el ID de una app (p. ej. de IPTV), no la MAC real. ${MAC_DONDE}`,
    );
  }
  const warning =
    first & 0x02
      ? `Ojo: «${mac}» es una MAC «administrada localmente» (suele ser aleatoria, de wifi). La guardo, pero si el encendido por red no funciona, compárala con Ajustes > General > Acerca de este TV.`
      : null;
  return { mac, warning };
}

/** Paquete magico: 6 x 0xFF + 16 repeticiones de la MAC (102 bytes). */
export function magicPacket(mac: string): Buffer {
  const bytes = Buffer.from(
    parseMac(mac)
      .split(':')
      .map((h) => Number.parseInt(h, 16)),
  );
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

/** Broadcast /24 de una IPv4 privada (192.168.1.237 -> 192.168.1.255); null si no aplica. */
export function subnetBroadcast(host: string | null | undefined): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec((host ?? '').trim());
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}.255`;
}

export type UdpSend = (packet: Buffer, address: string, port: number) => Promise<void>;

const defaultSend: UdpSend = (packet, address, port) =>
  new Promise<void>((resolve, reject) => {
    const sock = createSocket('udp4');
    const done = (err?: Error | null) => {
      try {
        sock.close();
      } catch {
        // cierre best-effort
      }
      if (err) reject(err);
      else resolve();
    };
    sock.once('error', (err) => done(err));
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch (err) {
        done(err as Error);
        return;
      }
      sock.send(packet, port, address, (err) => done(err));
    });
  });

export interface WakeOptions {
  /** IP de la tele: añade su broadcast /24 a los destinos. */
  host?: string | null;
  port?: number;
  /** Repeticiones por destino (UDP no confirma; 3 es lo habitual). */
  repeat?: number;
  send?: UdpSend;
}

/**
 * Envia el paquete magico. Devuelve los destinos a los que salio. Lanza solo
 * si no salio a NINGUNO (un destino fallido no invalida los demas).
 */
export async function sendWakeOnLan(mac: string, opts: WakeOptions = {}): Promise<string[]> {
  const packet = magicPacket(mac);
  const send = opts.send ?? defaultSend;
  const port = opts.port ?? 9;
  const repeat = Math.max(1, opts.repeat ?? 3);
  const targets = ['255.255.255.255'];
  const sub = subnetBroadcast(opts.host);
  if (sub && !targets.includes(sub)) targets.push(sub);
  const ok: string[] = [];
  let lastErr: unknown;
  for (const address of targets) {
    let sent = false;
    for (let i = 0; i < repeat; i += 1) {
      try {
        await send(packet, address, port);
        sent = true;
      } catch (err) {
        lastErr = err;
      }
    }
    if (sent) ok.push(address);
  }
  if (!ok.length) {
    throw new Error(
      `No pude enviar el paquete de encendido por red: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }
  return ok;
}

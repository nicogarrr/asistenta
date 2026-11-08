import { networkInterfaces } from 'node:os';
import type { AimSink } from './engine.js';
import { type AimServer, startAimServer } from './server.js';
import { TeleSink } from './tele.js';
import { WindowsSink } from './windows.js';

export const APUNTAR_USAGE =
  'pa apuntar pc|tele [--puerto N]   usa el iPhone como mando de apuntado (página en Safari, sin app ni Mac)';

/** IPv4 privadas de este PC (las que el móvil puede alcanzar). */
export function lanIps(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (
        i.family === 'IPv4' &&
        !i.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)
      ) {
        out.push(i.address);
      }
    }
  }
  return out;
}

export interface ApuntarDeps {
  ips?: string[];
  openPc?: () => Promise<AimSink & { close(): void }>;
  openTele?: () => Promise<AimSink & { close(): void }>;
  start?: typeof startAimServer;
  print?: (line: string) => void;
  /** Resuelve cuando hay que parar (Ctrl+C). */
  waitStop?: () => Promise<void>;
}

const defaultWait = (): Promise<void> =>
  new Promise((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });

async function openTeleFromVault(): Promise<AimSink & { close(): void }> {
  const { vaultGet } = await import('../vault.js');
  const [host, clientKey, secure, brand] = await Promise.all([
    vaultGet('tv:host'),
    vaultGet('tv:clientKey'),
    vaultGet('tv:secure'),
    vaultGet('tv:activeBrand'),
  ]);
  if (brand === 'sony' || brand === 'roku' || brand === 'samsung') {
    throw new Error('La tele activa no es una LG: el puntero solo existe en LG webOS.');
  }
  if (!host || !clientKey) {
    throw new Error('No hay una LG emparejada: primero `pa tv setup <ip>`.');
  }
  return TeleSink.open(host, clientKey, { allowPlaintext: secure === '0' });
}

export async function apuntarCommand(args: string[], deps: ApuntarDeps = {}): Promise<number> {
  const print = deps.print ?? ((l: string) => console.log(l));
  const target = args[0];
  if (target !== 'pc' && target !== 'tele') {
    print(`uso: ${APUNTAR_USAGE}`);
    return 1;
  }
  let port = 8443;
  const pi = args.indexOf('--puerto');
  if (pi >= 0) {
    port = Number(args[pi + 1]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      print('El puerto tiene que ser un número entre 1024 y 65535.');
      return 1;
    }
  }
  const ips = deps.ips ?? lanIps();
  if (ips.length === 0) {
    print(
      'No encuentro la red de casa (sin IP 192.168.x.x ni 10.x.x.x). Conecta el PC al wifi o al cable.',
    );
    return 1;
  }
  let sink: (AimSink & { close(): void }) | undefined;
  let server: AimServer | undefined;
  try {
    sink = await (target === 'pc'
      ? (deps.openPc ?? (() => WindowsSink.open()))()
      : (deps.openTele ?? openTeleFromVault)());
    server = await (deps.start ?? startAimServer)({ sink, ips, port, log: print });
    print(
      `Apuntar a ${target === 'pc' ? 'este PC' : 'la tele'} listo. En Safari del iPhone (misma wifi) abre:`,
    );
    for (const ip of ips) print(`  https://${ip}:${server.port}/?t=${server.token}`);
    print(
      'Safari avisará de que la conexión no es privada (certificado propio): «Mostrar detalles» y «visitar este sitio web».',
    );
    print(
      'Pulsa Empezar, permite el movimiento, apunta a la pantalla y pulsa Centrar. Ctrl+C para parar.',
    );
    if (target === 'tele') print('Aviso: el puntero se ve en la tele mientras lo usas.');
    await (deps.waitStop ?? defaultWait)();
    return 0;
  } catch (err) {
    print(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await server?.close();
    sink?.close();
  }
}

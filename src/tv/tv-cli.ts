/** Comandos `pa tv ...`: setup (pairing una vez), toast, apps, launch, off. */

import { existsSync, writeFileSync } from 'node:fs';
import {
  assertTvHost,
  pairTv,
  sanitizeTvText,
  tvKey,
  tvRequest,
  tvScreenshot,
  tvToast,
} from './lgtv.js';
import { describeTvIntent, parseTvCommand, tvIntentNotice, tvOrderHasTime } from './natural.js';
import { readNeighborMac } from './neighbor-mac.js';
import { TV_CHAT_MAX_LEN } from './tv-chat-command.js';
import { sendWakeOnLan, validateTvMac } from './wol.js';

const TV_HOST_KEY = 'tv:host';
const TV_CLIENT_KEY = 'tv:clientKey';
const TV_SECURE_KEY = 'tv:secure';
const TV_MAC_KEY = 'tv:mac';

/** MAC de la tele desde connectionmanager/getinfo (cable primero, luego wifi). */
export function macFromNetworkInfo(info: unknown): string | null {
  const rec = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const root = rec(info);
  for (const key of ['wiredInfo', 'wifiInfo']) {
    const raw = rec(root[key]).macAddress;
    if (typeof raw !== 'string') continue;
    try {
      // Misma validación que `pa tv mac`: una MAC multicast (ID de app), todo
      // ceros o broadcast no es la de la tarjeta de red y no sirve para WoL.
      return validateTvMac(raw).mac;
    } catch {
      // MAC ausente, basura o imposible: probar la siguiente interfaz
    }
  }
  return null;
}

/**
 * Si la tele olvido la client-key (reset, actualizacion de webOS) y Nico acepta
 * el aviso de nuevo, la clave nueva se guarda: sin esto cada `pa tv …` volveria
 * a sacar el aviso (igual que la tool tv, #660).
 */
async function saveNewClientKey(key: string): Promise<void> {
  const { vaultSet } = await import('../vault.js');
  await vaultSet(TV_CLIENT_KEY, key);
  process.stderr.write('pa tv: la tele se ha vuelto a emparejar; client-key nueva guardada.\n');
}

async function requirePaired(): Promise<{
  host: string;
  clientKey: string;
  allowPlaintext: boolean;
  onNewClientKey: (key: string) => Promise<void>;
}> {
  const { vaultGet } = await import('../vault.js');
  const host = await vaultGet(TV_HOST_KEY);
  const clientKey = await vaultGet(TV_CLIENT_KEY);
  if (!host || !clientKey) {
    throw new Error(
      'Tele no emparejada: ejecuta primero `pa tv setup <ip>` con la tele encendida.',
    );
  }
  // Si el pairing solo pudo ir por ws (3000), los requests siguen por ws; si
  // fue por wss, el downgrade a ws queda prohibido (ver lgtv.ts).
  return {
    host,
    clientKey,
    allowPlaintext: (await vaultGet(TV_SECURE_KEY)) === '0',
    onNewClientKey: saveNewClientKey,
  };
}

export interface TvCliDeps {
  /** Ejecuta una orden en castellano con la tool tv (action=command). */
  runOrder?: (text: string) => Promise<string>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** `pa tv mac auto`: MAC de la IP en la tabla de vecinos (tests: falso). */
  neighborMac?: (ip: string) => Promise<string | null>;
}

export const TV_ORDER_USAGE =
  'uso: pa tv orden "<texto>"  (p. ej. pa tv orden "apaga la tele", pa tv orden "volumen a 15")';

/**
 * `pa tv orden "<texto>"`: la misma orden simple que `/tv` en Telegram, desde
 * la terminal del PC y SIN modelo. Mismo parser (natural.ts) y misma tool
 * (action=command). Si no se entiende, se dice y no se ejecuta nada.
 */
export async function tvOrderCommand(text: string, deps: TvCliDeps): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const err = deps.err ?? ((s: string) => process.stderr.write(s));
  const order = text.trim();
  if (!order) {
    err(`${TV_ORDER_USAGE}\n`);
    return 2;
  }
  if (order.length > TV_CHAT_MAX_LEN) {
    err(`La orden es demasiado larga (máx. ${TV_CHAT_MAX_LEN} caracteres).\n`);
    return 2;
  }
  const intent = parseTvCommand(order);
  if (!intent && tvOrderHasTime(order)) {
    // Como /tv: una orden con hora o condición no se ejecuta al momento (ni se programa aquí).
    err(
      `«${order.slice(0, 80)}» lleva hora o condición y \`pa tv orden\` solo hace cosas al momento: no he tocado la tele. Pídemelo por Telegram para programarlo.\n`,
    );
    return 2;
  }
  if (!intent) {
    err(
      `No he entendido «${order.slice(0, 80)}» como orden para la tele. Ejemplos: "apaga la tele", "abre Netflix", "volumen a 15", "silencio", "modo cine", "estado".\n`,
    );
    return 2;
  }
  if (!deps.runOrder) {
    err('Órdenes a la tele no disponibles en este proceso.\n');
    return 1;
  }
  try {
    const res = (await deps.runOrder(order)).trim();
    const notice = res ? tvIntentNotice(intent) : null;
    out(`${res || `Hecho: ${describeTvIntent(intent)}.`}${notice ? `\n${notice}` : ''}\n`);
    return 0;
  } catch (e) {
    err(
      `No he podido ${describeTvIntent(intent)}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
}

export async function tvCommand(args: string[], deps: TvCliDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'orden':
      return tvOrderCommand(rest.join(' '), deps);
    case 'setup': {
      const allowPlaintext = rest.includes('--allow-plaintext');
      const hostArg = rest.find((a) => !a.startsWith('--'))?.trim();
      if (!hostArg) {
        process.stderr.write(
          'uso: pa tv setup <ip> [--allow-plaintext]   (tele encendida; acepta el aviso en pantalla)\n',
        );
        return 2;
      }
      // Validar ANTES de imprimir: un host crudo podria meter controles de terminal.
      let host: string;
      try {
        host = assertTvHost(hostArg);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      if (allowPlaintext) {
        process.stdout.write(
          'AVISO: se acepta el canal ws://3000 SIN CIFRAR si el 3001 no abre: la client-key de emparejamiento podria viajar en claro por tu red local.\n',
        );
      }
      process.stdout.write(
        `Emparejando con ${host}: ACEPTA el aviso en la tele con el mando (tienes 120s)...\n`,
      );
      let paired: { clientKey: string; secure: boolean };
      try {
        paired = await pairTv(host, { allowPlaintext });
      } catch (err) {
        if (!allowPlaintext) {
          process.stderr.write(
            `${err instanceof Error ? err.message : String(err)}\n\n` +
              'Si la tele no abre el canal cifrado (3001), reintenta con:\n' +
              `  pa tv setup ${host} --allow-plaintext\n` +
              'solo si aceptas que la clave de emparejamiento viaje sin cifrar por tu wifi.\n',
          );
          return 1;
        }
        throw err;
      }
      const { clientKey, secure } = paired;
      // MAC para el encendido por red (Wake-on-LAN): best-effort, la tele
      // puede no conceder READ_NETWORK_STATE; sin ella todo sigue igual.
      let mac: string | null = null;
      try {
        mac = macFromNetworkInfo(
          await tvRequest(
            host,
            clientKey,
            'com.webos.service.connectionmanager/getinfo',
            {},
            {
              allowPlaintext: !secure,
            },
          ),
        );
      } catch {
        mac = null;
      }
      const { vaultSetMany } = await import('../vault.js');
      await vaultSetMany({
        [TV_HOST_KEY]: host,
        [TV_CLIENT_KEY]: clientKey,
        [TV_SECURE_KEY]: secure ? '1' : '0',
        ...(mac ? { [TV_MAC_KEY]: mac } : {}),
      });
      if (mac) process.stdout.write(`MAC guardada para encenderla por red: ${mac}\n`);
      process.stdout.write(
        secure
          ? 'Tele emparejada y guardada (canal cifrado). Prueba: pa tv toast "hola"\n'
          : 'Tele emparejada y guardada (canal ws sin cifrar: la tele no abrio el 3001).\n',
      );
      return 0;
    }
    case 'toast': {
      const message = rest.join(' ').trim();
      if (!message) {
        process.stderr.write('uso: pa tv toast <mensaje>\n');
        return 2;
      }
      const { host, clientKey, allowPlaintext, onNewClientKey } = await requirePaired();
      await tvToast(host, clientKey, message, { allowPlaintext, onNewClientKey });
      process.stdout.write('Toast enviado.\n');
      return 0;
    }
    case 'apps': {
      const { host, clientKey, allowPlaintext, onNewClientKey } = await requirePaired();
      const res = await tvRequest(
        host,
        clientKey,
        'com.webos.applicationManager/listLaunchPoints',
        {},
        { allowPlaintext, onNewClientKey },
      );
      const points = (res as { launchPoints?: { id: string; title: string }[] }).launchPoints ?? [];
      // Titulos remotos sanitizados: la tele no controla esta terminal.
      for (const p of points)
        process.stdout.write(`${sanitizeTvText(p.id)}\t${sanitizeTvText(p.title)}\n`);
      return 0;
    }
    case 'launch': {
      const appId = rest[0]?.trim();
      if (!appId) {
        process.stderr.write('uso: pa tv launch <appId>   (ids: pa tv apps)\n');
        return 2;
      }
      const { host, clientKey, allowPlaintext, onNewClientKey } = await requirePaired();
      await tvRequest(
        host,
        clientKey,
        'system.launcher/launch',
        { id: appId },
        { allowPlaintext, onNewClientKey },
      );
      process.stdout.write(`Lanzada ${appId}.\n`);
      return 0;
    }
    case 'off': {
      const { host, clientKey, allowPlaintext, onNewClientKey } = await requirePaired();
      await tvRequest(host, clientKey, 'system/turnOff', {}, { allowPlaintext, onNewClientKey });
      process.stdout.write('Tele apagada.\n');
      return 0;
    }
    case 'shot': {
      // `pa tv shot [fichero] [--key NOMBRE] [--force]`: si se pasa --key se
      // manda esa tecla antes de capturar (util para salir de una app antes
      // de mirar). Nunca sobrescribe un fichero existente sin --force.
      const positional: string[] = [];
      let keyName: string | undefined;
      let force = false;
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i];
        if (arg === undefined) continue;
        if (arg === '--key') {
          const value = rest[i + 1];
          if (!value || value.startsWith('--')) {
            process.stderr.write('pa tv shot: --key necesita un nombre (HOME, BACK...)\n');
            return 2;
          }
          keyName = value;
          i += 1;
          continue;
        }
        if (arg === '--force') {
          force = true;
          continue;
        }
        if (arg.startsWith('--')) {
          process.stderr.write(`pa tv shot: flag desconocido ${sanitizeTvText(arg)}\n`);
          return 2;
        }
        positional.push(arg);
      }
      const out = positional[0] ?? 'tv-shot.jpg';
      if (existsSync(out) && !force) {
        process.stderr.write(`pa tv shot: ${out} ya existe; usa --force para sobrescribir.\n`);
        return 2;
      }
      const { host, clientKey, allowPlaintext, onNewClientKey } = await requirePaired();
      const deps = { allowPlaintext, onNewClientKey };
      if (keyName) {
        await tvKey(host, clientKey, keyName, deps);
        // La app tarda en redirigir: sin esta espera la captura sale en negro.
        await new Promise((r) => setTimeout(r, 2500));
      }
      const bytes = await tvScreenshot(host, clientKey, deps);
      try {
        // Sin --force, 'wx' falla si el fichero aparecio durante la descarga
        // (TOCTOU): nunca se sobrescribe algo creado mientras tanto.
        writeFileSync(out, bytes, force ? undefined : { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          process.stderr.write(`pa tv shot: ${out} ya existe; usa --force para sobrescribir.\n`);
          return 2;
        }
        throw err;
      }
      process.stdout.write(
        `Captura guardada en ${out} (${bytes.length} bytes; firma comprobada, no decodificada).\n`,
      );
      return 0;
    }
    case 'key': {
      const name = rest.find((a) => !a.startsWith('--'))?.trim();
      if (!name) {
        process.stderr.write(
          'uso: pa tv key <NOMBRE>   (HOME, BACK, ENTER, LEFT, RIGHT, UP, DOWN)\n',
        );
        return 2;
      }
      const { host, clientKey, allowPlaintext, onNewClientKey } = await requirePaired();
      await tvKey(host, clientKey, name, { allowPlaintext, onNewClientKey });
      // El protocolo del socket de input no confirma la pulsacion: se
      // reporta el envio, no el efecto en la tele.
      process.stdout.write(`Tecla ${name} enviada (sin confirmacion de la tele).\n`);
      return 0;
    }
    case 'mac': {
      const { vaultGet, vaultSetMany } = await import('../vault.js');
      const out = deps.out ?? ((s: string) => void process.stdout.write(s));
      const err = deps.err ?? ((s: string) => void process.stderr.write(s));
      const raw = rest.find((a) => !a.startsWith('--'))?.trim();
      if (!raw) {
        const current = await vaultGet(TV_MAC_KEY);
        out(
          current
            ? `MAC de la tele: ${current}\n`
            : 'Sin MAC guardada. uso: pa tv mac AA:BB:CC:DD:EE:FF (Ajustes > General > Acerca de este TV) o pa tv mac auto\n',
        );
        return 0;
      }
      let candidate = raw;
      if (raw.toLowerCase() === 'auto') {
        const host = await vaultGet(TV_HOST_KEY);
        let ip: string;
        try {
          if (!host) throw new Error('sin ip');
          ip = assertTvHost(host);
        } catch {
          err(
            'No sé la IP de la tele: empareja primero con «pa tv setup <ip>» con la tele encendida, o pon la MAC a mano: pa tv mac AA:BB:CC:DD:EE:FF\n',
          );
          return 2;
        }
        const found = await (deps.neighborMac ?? ((h: string) => readNeighborMac(h)))(ip).catch(
          () => null,
        );
        if (!found) {
          err(
            `No encuentro la MAC de la tele (${ip}) en la tabla de red del PC. ¿Está encendida y en la misma red? Enciéndela y repite «pa tv mac auto», o mírala en Ajustes > General > Acerca de este TV.\n`,
          );
          return 2;
        }
        candidate = found;
      }
      let checked: { mac: string; warning: string | null };
      try {
        checked = validateTvMac(candidate);
      } catch (e) {
        err(`${e instanceof Error ? e.message : String(e)}\n`);
        return 2;
      }
      if (checked.warning) err(`${checked.warning}\n`);
      await vaultSetMany({ [TV_MAC_KEY]: checked.mac });
      out(
        `MAC guardada: ${checked.mac}${raw.toLowerCase() === 'auto' ? ' (leída de la red)' : ''}. Ya puedo encender la tele por red (pa tv wake).\n`,
      );
      return 0;
    }
    case 'wake': {
      const { vaultGet } = await import('../vault.js');
      const mac = await vaultGet(TV_MAC_KEY);
      if (!mac) {
        process.stderr.write('Sin MAC guardada: pa tv mac AA:BB:CC:DD:EE:FF\n');
        return 2;
      }
      const sent = await sendWakeOnLan(mac, { host: await vaultGet(TV_HOST_KEY) });
      process.stdout.write(
        `Encendido por red enviado a ${mac} (${sent.join(', ')}). UDP no confirma: mira la tele.\n`,
      );
      return 0;
    }
    default:
      process.stderr.write('uso: pa tv <orden|setup|toast|apps|launch|key|shot|off|mac|wake>\n');
      return 2;
  }
}

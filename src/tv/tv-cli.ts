/** Comandos `pa tv ...`: setup (pairing una vez), toast, apps, launch, off. */

import { existsSync, writeFileSync } from 'node:fs';
import { ensureActiveTv } from './auto-select.js';
import {
  braviaPowerOff,
  braviaPowerStatus,
  braviaSetMute,
  braviaSetVolume,
  braviaSystemInfo,
  braviaValidateMethods,
  braviaVolume,
  sonyModelYearText,
} from './bravia.js';
import { type DiscoveredTv, discoverWebOsTvs } from './discover.js';
import { loadKnownTvs, relocateMovedTvs } from './known-tvs.js';
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
import { findTv, parseRegistry, registryToJson, upsertTv, validateTvName } from './registry.js';
import { withoutTvPlace } from './target.js';
import { TV_CHAT_MAX_LEN } from './tv-chat-command.js';
import { sendWakeOnLan, validateTvMac } from './wol.js';

const TV_HOST_KEY = 'tv:host';
const TV_REGISTRY_KEY = 'tv:tvs';
const TV_ACTIVE_BRAND = 'tv:activeBrand';
/** PSK de cada Sony por host: tv:sonyPsk:<ip> (como la client-key, pero por tele). */
const sonyPskKey = (host: string) => `tv:sonyPsk:${host}`;

async function requireSonyPsk(): Promise<{ host: string; psk: string }> {
  const { vaultGet, vaultSetMany } = await import('../vault.js');
  const ensured = await ensureActiveTv({ vaultGet, vaultSetMany }).catch(() => null);
  if (ensured?.switchedTo) {
    process.stderr.write(
      `Tele activa ahora: ${ensured.switchedTo.name ?? ensured.switchedTo.host} (la anterior no responde en esta red).\n`,
    );
  }
  const host = await vaultGet(TV_HOST_KEY);
  const psk = host ? await vaultGet(sonyPskKey(host)) : undefined;
  if (!host || !psk) {
    throw new Error(
      'La tele activa no es una Sony configurada: emparejala con `pa tv setup-sony <ip>` (la clave PSK se pone en la tele, en Ajustes > Red > Home network setup > IP control).',
    );
  }
  return { host, psk };
}
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
  const { vaultGet, vaultSet } = await import('../vault.js');
  await vaultSet(TV_CLIENT_KEY, key);
  // El registro multi-tele guarda la clave nueva de la tele activa tambien.
  const host = await vaultGet(TV_HOST_KEY);
  if (host) {
    const list = parseRegistry(await vaultGet(TV_REGISTRY_KEY));
    const known = findTv(list, host);
    if (known)
      await vaultSet(TV_REGISTRY_KEY, registryToJson(upsertTv(list, { ...known, clientKey: key })));
  }
  process.stderr.write('pa tv: la tele se ha vuelto a emparejar; client-key nueva guardada.\n');
}

async function requirePaired(): Promise<{
  host: string;
  clientKey: string;
  allowPlaintext: boolean;
  onNewClientKey: (key: string) => Promise<void>;
}> {
  const { vaultGet, vaultSetMany } = await import('../vault.js');
  // Multi-casa: si la activa no responde en esta red y hay otra conocida
  // encendida, pasa a ser la activa (sin re-emparejar).
  const ensured = await ensureActiveTv({ vaultGet, vaultSetMany }).catch(() => null);
  if (ensured?.switchedTo) {
    process.stderr.write(
      `Tele activa ahora: ${ensured.switchedTo.name ?? ensured.switchedTo.host} (la anterior no responde en esta red).\n`,
    );
  }
  if ((await vaultGet(TV_ACTIVE_BRAND)) === 'sony') {
    throw new Error(
      'La tele activa es la Sony y esa orden es de la LG. Cambia con `pa tv usar <ip>` o usa `pa tv sony ...`.',
    );
  }
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
  /** `pa tv buscar` / `pa tv setup` sin IP: descubrimiento SSDP (tests: falso). */
  discover?: () => Promise<DiscoveredTv[]>;
}

function tvLabel(tv: {
  host: string;
  name?: string | undefined;
  brand?: string | undefined;
}): string {
  if (tv.brand === 'sony') return `Sony Bravia (${tv.host})`;
  return tv.name ? `${tv.name} (${tv.host})` : tv.host;
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
  const intent = parseTvCommand(order) ?? parseTvCommand(withoutTvPlace(order));
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
      let hostArg = rest.find((a) => !a.startsWith('--'))?.trim();
      let picked: DiscoveredTv | undefined;
      if (!hostArg) {
        // Sin IP: busca las LG de la red y, si solo hay una sin emparejar, va con ella.
        const out = deps.out ?? ((s: string) => void process.stdout.write(s));
        const err = deps.err ?? ((s: string) => void process.stderr.write(s));
        out('Buscando teles LG en la red (3 s)...\n');
        const found = (
          await (deps.discover ?? (() => discoverWebOsTvs()))().catch(() => [])
        ).filter((t) => t.brand === 'lg');
        const known = await loadKnownTvs();
        const fresh = found.filter((t) => !findTv(known, t.ip));
        if (fresh.length === 1) {
          picked = fresh[0];
          hostArg = picked?.ip;
          out(`He encontrado ${tvLabel({ host: picked?.ip ?? '', name: picked?.name })}.\n`);
        } else if (fresh.length > 1) {
          out('He encontrado varias teles LG sin emparejar. Elige una:\n');
          for (const t of fresh)
            out(
              `  pa tv setup ${t.ip}   ·  ${t.name ?? 'sin nombre'}${t.model ? `  ·  ${t.model}` : ''}\n`,
            );
          return 2;
        } else {
          err(
            found.length > 0
              ? 'Las LG que veo en la red ya están emparejadas (pa tv teles). Para otra: pa tv setup <ip>\n'
              : 'No veo ninguna tele LG encendida en esta red. Enciéndela (misma wifi que el PC) o usa: pa tv setup <ip> [--allow-plaintext]\n',
          );
          return 2;
        }
      }
      if (!hostArg) return 2;
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
      const { vaultSet, vaultSetMany } = await import('../vault.js');
      // Registro EFECTIVO ANTES de tocar las claves sueltas: si la tele
      // activa era de antes del registro, queda migrada aqui abajo (momento
      // de escritura real). Despues de vaultSetMany ya no se podria leer.
      const effective = await loadKnownTvs();
      await vaultSetMany({
        [TV_HOST_KEY]: host,
        [TV_CLIENT_KEY]: clientKey,
        [TV_SECURE_KEY]: secure ? '1' : '0',
        [TV_ACTIVE_BRAND]: 'lg',
        ...(mac ? { [TV_MAC_KEY]: mac } : {}),
      });
      // Registro multi-tele: esta queda guardada y pasa a ser la activa.
      const prev = findTv(effective, host);
      const name = prev?.name ?? picked?.name;
      const model = prev?.model ?? picked?.model;
      const uuid = prev?.uuid ?? picked?.uuid;
      await vaultSet(
        TV_REGISTRY_KEY,
        registryToJson(
          upsertTv(effective, {
            host,
            ...(name ? { name } : {}),
            ...(model ? { model } : {}),
            ...(uuid ? { uuid } : {}),
            clientKey,
            secure: secure ? '1' : '0',
            ...(mac ? { mac } : {}),
            pairedAt: new Date().toISOString(),
          }),
        ),
      );
      if (mac) process.stdout.write(`MAC guardada para encenderla por red: ${mac}\n`);
      process.stdout.write(
        secure
          ? 'Tele emparejada y guardada (canal cifrado). Prueba: pa tv toast "hola"\n'
          : 'Tele emparejada y guardada (canal ws sin cifrar: la tele no abrio el 3001).\n',
      );
      return 0;
    }
    case 'setup-sony': {
      const hostArg = rest.find((a) => !a.startsWith('--'))?.trim();
      if (!hostArg) {
        process.stderr.write(
          'uso: pa tv setup-sony <ip>   (la PSK la lees de la tele: Ajustes > Red > Home network setup > IP control)\n',
        );
        return 2;
      }
      let host: string;
      try {
        host = assertTvHost(hostArg);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return 2;
      }
      // PSK por stdin para que no quede en el historial de la consola.
      process.stdout.write('Pega la clave PSK de la tele y pulsa Enter: ');
      const psk = await new Promise<string>((resolve) => {
        let buf = '';
        process.stdin.resume();
        process.stdin.on('data', (chunk) => {
          buf += String(chunk);
          const nl = buf.indexOf('\n');
          if (nl >= 0) {
            process.stdin.pause();
            resolve(buf.slice(0, nl));
          }
        });
      });
      if (!psk.trim()) {
        process.stderr.write('Sin clave no puedo emparejar: no se guarda nada.\n');
        return 1;
      }
      const info = await braviaSystemInfo(host, psk.trim()).catch((err: unknown) => {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        return null;
      });
      if (!info) return 1;
      // Validacion real contra el modelo detectado: que responda lo que usamos.
      const validation = await braviaValidateMethods(host, psk.trim());
      const { vaultSet, vaultSetMany } = await import('../vault.js');
      await vaultSet(sonyPskKey(host), psk.trim());
      await vaultSet(
        TV_REGISTRY_KEY,
        registryToJson(
          upsertTv(await loadKnownTvs(), {
            host,
            brand: 'sony',
            clientKey: '',
            secure: '1',
            ...(info.name ? { name: info.name } : {}),
            ...(info.model ? { model: info.model } : {}),
            pairedAt: new Date().toISOString(),
          }),
        ),
      );
      await vaultSetMany({ [TV_HOST_KEY]: host, [TV_ACTIVE_BRAND]: 'sony' });
      process.stdout.write(
        `Sony Bravia emparejada y activa${info.model ? ` (${info.model}, ${sonyModelYearText(info.model)})` : ''}.\n`,
      );
      if (validation.failed.length > 0) {
        process.stdout.write(
          `Ojo: no me ha respondido a ${validation.failed.join(', ')}; lo demas (${validation.ok.length} metodos) va bien.\n`,
        );
      } else {
        process.stdout.write('Validada contra la tele: responde a todo lo que uso.\n');
      }
      return 0;
    }
    case 'sony': {
      const what = rest[0]?.trim().toLowerCase();
      const { host, psk } = await requireSonyPsk();
      if (what === 'estado' || what === 'status') {
        const [power, vol] = await Promise.all([
          braviaPowerStatus(host, psk),
          braviaVolume(host, psk).catch(() => null),
        ]);
        const volTxt = vol ? `, volumen ${vol.volume}${vol.mute ? ' (silenciada)' : ''}` : '';
        process.stdout.write(`Sony ${host}: ${power}${volTxt}.\n`);
        return 0;
      }
      if (what === 'volumen') {
        const n = Number(rest[1]);
        if (!Number.isFinite(n)) {
          process.stderr.write('uso: pa tv sony volumen <0-100>\n');
          return 2;
        }
        await braviaSetVolume(host, psk, n);
        process.stdout.write(`Volumen al ${Math.max(0, Math.min(100, Math.round(n)))}.\n`);
        return 0;
      }
      if (what === 'mute' || what === 'silencio') {
        await braviaSetMute(host, psk, true);
        process.stdout.write('Silenciada.\n');
        return 0;
      }
      if (what === 'sonido') {
        await braviaSetMute(host, psk, false);
        process.stdout.write('Sonido de vuelta.\n');
        return 0;
      }
      if (what === 'apaga' || what === 'off') {
        await braviaPowerOff(host, psk);
        process.stdout.write('Apagada (en espera).\n');
        return 0;
      }
      process.stderr.write(
        'uso: pa tv sony estado|volumen <n>|mute|sonido|apaga   (encender es por Wake-on-LAN con «Remote start» activo en la tele)\n',
      );
      return 2;
    }
    case 'buscar':
    case 'descubrir': {
      const out = deps.out ?? ((s: string) => void process.stdout.write(s));
      // Solo lectura: el M-SEARCH no muestra nada en pantalla.
      const found = await (deps.discover ?? (() => discoverWebOsTvs()))();
      if (found.length === 0) {
        out(
          'No he encontrado teles LG webOS encendidas en esta red. ¿Estan en la misma wifi que el PC?\n',
        );
        return 0;
      }
      // Una tele guardada que el router cambio de IP se reconoce (MAC/UUID) y se actualiza.
      for (const m of await relocateMovedTvs(found, deps)) {
        out(`${tvLabel(m.tv)} ha cambiado de IP: ${m.from} → ${m.to}. Actualizada.\n`);
      }
      const known = await loadKnownTvs();
      for (const tv of found) {
        const partes = [
          tv.ip,
          tv.brand === 'sony'
            ? `Sony Bravia${tv.model ? ` ${tv.model}` : ''}${tv.model ? ` (${sonyModelYearText(tv.model)})` : ''}`
            : (tv.name ?? 'sin nombre'),
          ...(tv.brand === 'sony' ? [] : tv.model ? [tv.model] : []),
          tv.glasshouse ? 'rooteada (Glasshouse)' : tv.brand === 'sony' ? 'IP Control' : 'webOS',
          findTv(known, tv.ip)
            ? 'ya emparejada'
            : tv.brand === 'sony'
              ? `emparejar: pa tv setup-sony ${tv.ip}`
              : `emparejar: pa tv setup ${tv.ip}`,
        ];
        out(`${partes.join('  ·  ')}\n`);
      }
      return 0;
    }
    case 'donde': {
      const { vaultGet, vaultSetMany } = await import('../vault.js');
      const ensured = await ensureActiveTv({ vaultGet, vaultSetMany });
      if (ensured.switchedTo) {
        process.stdout.write(
          `Cambio de tele: ahora la activa es ${ensured.switchedTo.name ?? ensured.switchedTo.host}.\n`,
        );
      }
      const found = await discoverWebOsTvs({ probeGlasshouse: false });
      const known = await loadKnownTvs();
      const active = await vaultGet(TV_HOST_KEY);
      if (found.length === 0) {
        process.stdout.write('No veo ninguna tele encendida en esta red.\n');
        return 0;
      }
      for (const tv of found) {
        const k = findTv(known, tv.ip);
        const marca = tv.brand === 'sony' ? 'Sony Bravia' : 'LG webOS';
        const quien = k ? `tu tele${tv.ip === active ? ' (activa)' : ''}` : 'no emparejada';
        process.stdout.write(
          `${tv.ip}  ${marca}${tv.model ? ` ${tv.model}` : ''}${tv.brand === 'sony' && tv.model ? ` (${sonyModelYearText(tv.model)})` : ''}  ${quien}\n`,
        );
      }
      return 0;
    }
    case 'teles': {
      const { vaultGet } = await import('../vault.js');
      const list = await loadKnownTvs();
      const active = await vaultGet(TV_HOST_KEY);
      if (list.length === 0) {
        process.stdout.write('No hay teles emparejadas. Empareja una con: pa tv setup <ip>\n');
        return 0;
      }
      for (const tv of list) {
        const partes = [
          tv.host === active ? '(activa)' : '        ',
          tv.host,
          tv.brand === 'sony' ? 'Sony' : (tv.name ?? 'sin nombre'),
          ...(tv.model ? [tv.model] : []),
          tv.secure === '1' ? 'cifrada' : 'sin cifrar',
          ...(tv.mac ? [`MAC ${tv.mac}`] : []),
        ];
        process.stdout.write(`${partes.join('  ')}\n`);
      }
      return 0;
    }
    case 'usar': {
      const want = rest.find((a) => !a.startsWith('--'))?.trim();
      if (!want) {
        process.stderr.write('uso: pa tv usar <ip|nombre>   (cambia la tele activa)\n');
        return 2;
      }
      const { vaultSetMany } = await import('../vault.js');
      const list = await loadKnownTvs();
      const tv = findTv(list, want);
      if (!tv) {
        process.stderr.write(
          `No tengo emparejada ninguna tele «${want}». Mira las tuyas con: pa tv teles (o descubre otras con: pa tv descubrir)\n`,
        );
        return 1;
      }
      await vaultSetMany({
        [TV_HOST_KEY]: tv.host,
        [TV_ACTIVE_BRAND]: tv.brand ?? 'lg',
        ...(tv.brand === 'sony'
          ? {}
          : { [TV_CLIENT_KEY]: tv.clientKey, [TV_SECURE_KEY]: tv.secure }),
        ...(tv.mac ? { [TV_MAC_KEY]: tv.mac } : {}),
      });
      process.stdout.write(
        `Tele activa: ${tv.brand === 'sony' ? `Sony Bravia (${tv.host})` : tv.name ? `${tv.name} (${tv.host})` : tv.host}.\n`,
      );
      return 0;
    }
    case 'nombre': {
      const out = deps.out ?? ((s: string) => void process.stdout.write(s));
      const err = deps.err ?? ((s: string) => void process.stderr.write(s));
      const [which, ...words] = rest.filter((a) => !a.startsWith('--'));
      if (!which || words.length === 0) {
        err(
          'uso: pa tv nombre <ip|nombre> <nombre nuevo>   (p. ej. pa tv nombre 192.168.1.20 salón)\n',
        );
        return 2;
      }
      let name: string;
      try {
        name = validateTvName(words.join(' '));
      } catch (e) {
        err(`${e instanceof Error ? e.message : String(e)}\n`);
        return 2;
      }
      const list = await loadKnownTvs();
      const tv = findTv(list, which);
      if (!tv) {
        err(
          `No tengo emparejada ninguna tele «${which.slice(0, 40)}». Mira las tuyas con: pa tv teles\n`,
        );
        return 1;
      }
      const clash = findTv(list, name);
      if (clash && clash.host !== tv.host) {
        err(`Ya hay otra tele que se llama «${name}» (${clash.host}). Elige otro nombre.\n`);
        return 2;
      }
      const { vaultSet } = await import('../vault.js');
      await vaultSet(TV_REGISTRY_KEY, registryToJson(upsertTv(list, { ...tv, name })));
      out(
        `Ahora la tele ${tv.host} se llama «${name}». Puedes decir, por ejemplo, «apaga la tele del ${name}».\n`,
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
      process.stdout.write(`Tecla ${name} enviada (sin confirmación de la tele).\n`);
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
      // `pa tv wake <ip|nombre>`: enciende esa tele; sin nada, la activa (como siempre).
      const which = rest.find((a) => !a.startsWith('--'))?.trim();
      let mac = await vaultGet(TV_MAC_KEY);
      let wakeHost = await vaultGet(TV_HOST_KEY);
      if (which) {
        const tv = findTv(await loadKnownTvs(), which);
        if (!tv) {
          process.stderr.write(
            `No tengo emparejada ninguna tele «${which.slice(0, 40)}». Mira las tuyas con: pa tv teles\n`,
          );
          return 1;
        }
        mac = tv.mac ?? (tv.host === wakeHost ? mac : undefined);
        wakeHost = tv.host;
      }
      if (!mac) {
        process.stderr.write('Sin MAC guardada: pa tv mac AA:BB:CC:DD:EE:FF\n');
        return 2;
      }
      const sent = await sendWakeOnLan(mac, { host: wakeHost });
      process.stdout.write(
        `Encendido por red enviado a ${mac} (${sent.join(', ')}). UDP no confirma: mira la tele.\n`,
      );
      return 0;
    }
    default:
      process.stderr.write(
        'uso: pa tv <orden|setup|buscar|teles|usar|nombre|toast|apps|launch|key|shot|off|mac|wake>\n',
      );
      return 2;
  }
}

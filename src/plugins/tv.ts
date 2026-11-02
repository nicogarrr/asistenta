/**
 * Plugin de la tele LG (SmartTV): todo su cableado vive aquí y no en cli.ts.
 *
 * Movido tal cual desde cli.ts (sin cambiar comportamiento): `tvToolDeps` une la tool
 * `tv` al cliente SSAP real, a Glasshouse y al vault. Lo usan el daemon (lista de
 * herramientas), `pa tv orden` y `/tv` en Telegram.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../db.js';
import { log } from '../log.js';
import { paths } from '../paths.js';
import { createTvTool, type TvMemoryState, type TvToolDeps } from '../tools/tv.js';
import { discoverWebOsTvs } from '../tv/discover.js';
import { GlasshouseClient, GlasshouseUnavailableError } from '../tv/glasshouse.js';
import { loadKnownTvs, relocateMovedTvs, saveTvClientKey } from '../tv/known-tvs.js';
import { tvKey, tvRequest, tvScreenshot, tvToast } from '../tv/lgtv.js';
import { tvPower } from '../tv/power.js';
import { readTvStatus } from '../tv/status.js';
import {
  currentTvTarget,
  extractTvTarget,
  isTvUnreachable,
  tvTargetLabel,
  withTvTarget,
} from '../tv/target.js';
import { sendWakeOnLan } from '../tv/wol.js';
import { vaultGet, vaultSet, vaultSetMany } from '../vault.js';
import type { CapabilityPlugin } from './types.js';

/**
 * Cableado de la tool `tv` al cliente SSAP real.
 *
 * La emparejacion vive en el vault (tv:host / tv:clientKey / tv:secure), escrita
 * por `pa tv setup`. Si no hay pairing, TODAS las acciones fallan aqui con un
 * mensaje que el modelo puede leer, en vez de romper el arranque del agente: la
 * tele es opcional y su ausencia no puede tumbar el resto.
 */
export function tvToolDeps(store: Store): TvToolDeps {
  const frameDir = join(paths.screenshots, 'tv');
  mkdirSync(frameDir, { recursive: true });
  const STATE_KEY = 'tv:lastLook';
  // Si la tele olvido la client-key y Nico acepta el aviso de nuevo, la clave
  // nueva se guarda: sin esto cada orden volveria a sacar el aviso.
  const saveNewKey = async (key: string): Promise<void> => {
    // Orden a otra tele (no la activa): su clave va a su entrada, no a la de la activa.
    const target = currentTvTarget();
    if (target) {
      await saveTvClientKey(target.host, key);
      log.info('tv: una tele del registro se ha vuelto a emparejar; client-key nueva guardada');
      return;
    }
    await vaultSet('tv:clientKey', key);
    log.info('tv: la tele se ha vuelto a emparejar; client-key nueva guardada');
  };

  const paired = async (): Promise<{
    host: string;
    clientKey: string;
    allowPlaintext: boolean;
  }> => {
    const target = currentTvTarget();
    if (target) {
      return {
        host: target.host,
        clientKey: target.clientKey,
        allowPlaintext: target.secure === '0',
      };
    }
    // Multi-casa: si la activa no responde en esta red y hay otra tele
    // conocida encendida, la activa pasa a ser esa (sin re-emparejar).
    try {
      const { ensureActiveTv } = await import('../tv/auto-select.js');
      const ensured = await ensureActiveTv({ vaultGet, vaultSetMany });
      if (ensured.switchedTo) {
        log.info('tv: tele activa cambiada al llegar a otra red', {
          host: ensured.switchedTo.host,
          brand: ensured.switchedTo.brand,
        });
      }
    } catch (err) {
      log.warn('tv: auto-seleccion de tele fallo; sigo con la activa guardada', {
        err: String(err),
      });
    }
    const host = await vaultGet('tv:host');
    const clientKey = await vaultGet('tv:clientKey');
    if (!host || !clientKey) {
      throw new Error(
        'La tele no esta emparejada. Emparejala una vez con: pa tv setup <ip-de-la-television>',
      );
    }
    return { host, clientKey, allowPlaintext: (await vaultGet('tv:secure')) === '0' };
  };

  /**
   * Glasshouse (API :8080 de la tele rooteada): via primaria para volumen
   * absoluto, inputs, url, closeApp, picture y privacidad, y transporte
   * preferente de launch/toast/power. Default: LAN primero, tailnet de
   * fallback (el nodo tailscale de la tele tarda en volver tras un reinicio).
   * Override con vault tv:glasshouseUrl (lista separada por comas) y token
   * con tv:glasshouseToken. Los endpoints invalidos fallan al CONSTRUIR el
   * cliente, en la llamada - nunca en el arranque del agente.
   */
  const GH_DEFAULT_ENDPOINTS = ['http://192.168.1.237:8080', 'http://100.126.88.124:8080'];
  const ghClient = async (): Promise<GlasshouseClient> => {
    // Orden a otra tele: Glasshouse solo en SU IP (si no esta rooteada, falla
    // como inalcanzable y se sigue por SSAP); nunca los endpoints de la activa.
    const target = currentTvTarget();
    if (target && target.host !== (await vaultGet('tv:host'))) {
      return new GlasshouseClient({ endpoints: [`http://${target.host}:8080`] });
    }
    const override = await vaultGet('tv:glasshouseUrl');
    const endpoints = override?.trim()
      ? override
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : GH_DEFAULT_ENDPOINTS;
    return new GlasshouseClient({ endpoints, token: await vaultGet('tv:glasshouseToken') });
  };

  /**
   * Si la IP guardada ya no contesta (el router le dio otra), busca la tele
   * por MAC/UUID y reintenta UNA vez: solo cuando no se llego a conectar
   * (TvUnreachableError = no salio nada), nunca tras una orden ambigua.
   */
  const withRelocation = async <T>(
    host: string,
    fn: () => Promise<T>,
    retarget: (newHost: string) => (fn: () => Promise<T>) => Promise<T>,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!isTvUnreachable(err)) throw err;
      const moves = await relocateMovedTvs(
        await discoverWebOsTvs({ probeGlasshouse: false }).catch(() => []),
      ).catch(() => []);
      const move = moves.find((m) => m.from === host);
      if (!move) throw err;
      log.info('tv: la tele ha cambiado de IP; reintento en la nueva', {
        from: move.from,
        to: move.to,
      });
      return retarget(move.to)(fn);
    }
  };

  const routeOrder: TvToolDeps['routeOrder'] = async (text) => {
    const known = await loadKnownTvs();
    const active = await vaultGet('tv:host');
    const found = extractTvTarget(text, known);
    const direct = <T>(fn: () => Promise<T>) => fn();
    if (found.ask) return { text, ask: found.ask, run: direct };
    const tv = found.tv;
    if (!tv || tv.host === active) {
      // La activa: el cableado de siempre (claves sueltas), sin contexto.
      return {
        text: found.text,
        ...(tv ? { label: tvTargetLabel(tv) } : {}),
        // Si cambió de IP, ensureActiveTv (auto-select.ts) ya la reencuentra en paired().
        run: direct,
      };
    }
    if (tv.brand === 'sony') {
      return {
        text,
        ask: `«${tvTargetLabel(tv)}» es una Sony: de momento se maneja con «pa tv sony ...» o haciéndola la activa (pa tv usar ${tv.host}).`,
        run: direct,
      };
    }
    return {
      text: found.text,
      label: tvTargetLabel(tv),
      run: <T>(fn: () => Promise<T>) =>
        withTvTarget(tv, () =>
          withRelocation(tv.host, fn, (to) => (again) => withTvTarget({ ...tv, host: to }, again)),
        ),
    };
  };

  return {
    routeOrder,
    shot: async () => {
      const { host, clientKey, allowPlaintext } = await paired();
      const image = await tvScreenshot(host, clientKey, {
        allowPlaintext,
        onNewClientKey: saveNewKey,
      });
      // El mime/ext salen de la FIRMA real del frame: la tele decide el
      // formato, no el cliente (tvScreenshot acepta JPEG y PNG).
      const jpeg = image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
      const png = image[0] === 0x89 && image[1] === 0x50 && image[2] === 0x4e && image[3] === 0x47;
      if (png) return { image, mimeType: 'image/png', ext: 'png' };
      if (jpeg) return { image, mimeType: 'image/jpeg', ext: 'jpg' };
      return { image, mimeType: 'application/octet-stream', ext: 'bin' };
    },
    foreground: async () => {
      const { host, clientKey, allowPlaintext } = await paired();
      const res = await tvRequest(
        host,
        clientKey,
        'com.webos.applicationManager/getForegroundAppInfo',
        {},
        { allowPlaintext, onNewClientKey: saveNewKey },
      );
      const p = res as { appId?: string; appCategory?: string[] };
      return { appId: p.appId ?? 'desconocida', category: p.appCategory ?? [] };
    },
    apps: async () => {
      const { host, clientKey, allowPlaintext } = await paired();
      const res = await tvRequest(
        host,
        clientKey,
        'com.webos.applicationManager/listLaunchPoints',
        {},
        { allowPlaintext, onNewClientKey: saveNewKey },
      );
      const points = (res as { launchPoints?: { id: string; title: string }[] }).launchPoints ?? [];
      return points.map((p) => ({ id: p.id, title: p.title }));
    },
    launch: async (id) => {
      // Glasshouse primero (sin pairing); si la tele no lo tiene o no
      // responde, SSAP con la client-key guardada.
      try {
        await (await ghClient()).control('launchApp', id);
        return;
      } catch (err) {
        // Fallback a SSAP SOLO si Glasshouse no llego a recibir la orden
        // (conexion nunca establecida). Un rechazo (ok:false, 4xx/5xx,
        // allowPower=false) o una escritura ambigua JAMAS se repiten por
        // otro transporte: respetan la config de la tele (auditor #104 r1).
        if (!(err instanceof GlasshouseUnavailableError)) throw err;
        log.info('tv launch: Glasshouse inalcanzable, pruebo SSAP', { err: String(err) });
      }
      const { host, clientKey, allowPlaintext } = await paired();
      await tvRequest(
        host,
        clientKey,
        'system.launcher/launch',
        { id },
        { allowPlaintext, onNewClientKey: saveNewKey },
      );
    },
    key: async (name) => {
      const { host, clientKey, allowPlaintext } = await paired();
      await tvKey(host, clientKey, name, { allowPlaintext, onNewClientKey: saveNewKey });
    },
    toast: async (message) => {
      try {
        await (await ghClient()).control('toast', message);
        return;
      } catch (err) {
        // Fallback a SSAP SOLO si Glasshouse no llego a recibir la orden
        // (conexion nunca establecida). Un rechazo (ok:false, 4xx/5xx,
        // allowPower=false) o una escritura ambigua JAMAS se repiten por
        // otro transporte: respetan la config de la tele (auditor #104 r1).
        if (!(err instanceof GlasshouseUnavailableError)) throw err;
        log.info('tv toast: Glasshouse inalcanzable, pruebo SSAP', { err: String(err) });
      }
      const { host, clientKey, allowPlaintext } = await paired();
      await tvToast(host, clientKey, message, { allowPlaintext, onNewClientKey: saveNewKey });
    },
    power: async (on) => {
      // Cadena Glasshouse -> SSAP -> Wake-on-LAN en src/tv/power.ts (reglas del
      // auditor #104 r1 intactas: solo se cambia de transporte si la orden no
      // llego). El WoL solo existe con la MAC guardada (pa tv mac).
      const target = currentTvTarget();
      const mac = target ? target.mac : await vaultGet('tv:mac');
      const host = target ? target.host : await vaultGet('tv:host');
      return tvPower(on, {
        gh: async (action) => {
          await (await ghClient()).control(action);
        },
        ssap: async (uri, payload) => {
          const p = await paired();
          return tvRequest(p.host, p.clientKey, uri, payload, {
            allowPlaintext: p.allowPlaintext,
            onNewClientKey: saveNewKey,
          });
        },
        wake: mac ? () => sendWakeOnLan(mac, { host }) : undefined,
        probe: async () => {
          const p = await paired();
          await tvRequest(
            p.host,
            p.clientKey,
            'com.webos.service.tvpower/power/getPowerState',
            {},
            {
              allowPlaintext: p.allowPlaintext,
              // Cada sondeo tras el WoL: con la tele aun dormida no hay que
              // esperar 5 s por intento; 2 s basta en la red de casa.
              connectTimeoutMs: 2_000,
              onNewClientKey: saveNewKey,
              commandTimeoutMs: 3_000,
              connectRetries: 0,
            },
          );
          return true;
        },
        info: (msg, data) => log.info(msg, data),
      });
    },
    status: async () => {
      const p = await paired();
      const ssap = (uri: string, payload: Record<string, unknown>) =>
        tvRequest(p.host, p.clientKey, uri, payload, {
          allowPlaintext: p.allowPlaintext,
          onNewClientKey: saveNewKey,
          commandTimeoutMs: 4_000,
          // Los reintentos los hace readTvStatus (3 intentos, tope ~6 s, tambien
          // si la apertura se queda colgada con la tele en reposo): aqui uno
          // solo y 1,5 s por apertura, que en la red de casa sobra.
          connectRetries: 0,
          connectTimeoutMs: 1_500,
        });
      return readTvStatus({
        ssap,
        apps: async () => {
          const res = await ssap('com.webos.applicationManager/listLaunchPoints', {});
          return (
            (res as { launchPoints?: { id: string; title: string }[] }).launchPoints ?? []
          ).map((lp) => ({ id: lp.id, title: lp.title }));
        },
      });
    },
    stats: async () => (await ghClient()).getJson('/api/stats'),
    ghControl: async (action, value) => {
      await (await ghClient()).control(action, value);
    },
    saveFrame: (bytes, ext) => {
      // UUID + wx: dos agentes (o dos capturas en el mismo ms) nunca pisan el
      // frame del otro, y el recuerdo apunta siempre a SUS bytes.
      const file = join(frameDir, `tv-${randomUUID()}.${ext}`);
      writeFileSync(file, bytes, { flag: 'wx' });
      return file;
    },
    getState: () => {
      const raw = store.kvGet(STATE_KEY);
      if (!raw) return null;
      try {
        // kv es disco, no memoria: validar la ESTRUCTURA antes de fiarse.
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const s = parsed as Record<string, unknown>;
        if (
          typeof s.appId !== 'string' ||
          !Array.isArray(s.category) ||
          !s.category.every((c) => typeof c === 'string') ||
          typeof s.at !== 'string' ||
          typeof s.framePath !== 'string' ||
          typeof s.bytes !== 'number'
        ) {
          return null;
        }
        return s as unknown as TvMemoryState;
      } catch {
        // kv corrupto: se descarta en silencio y se vuelve a mirar la tele.
        return null;
      }
    },
    setState: (state) => {
      store.kvSet(STATE_KEY, JSON.stringify(state));
    },
  };
}

/** La tele como plugin: una tool `tv` por Store. Modos/exclusividad salen del catálogo (core/capabilities.ts). */
export const tvPlugin: CapabilityPlugin<{ store: Store; staleOrder?: () => string | null }> = {
  id: 'tv',
  tools: ({ store, staleOrder }) => [createTvTool({ ...tvToolDeps(store), staleOrder })],
};

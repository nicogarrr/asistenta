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
import { createTvAppCache } from '../tv/app-cache.js';
import { discoverWebOsTvs } from '../tv/discover.js';
import { runIntentOnDriver } from '../tv/drivers.js';
import { GlasshouseClient, GlasshouseUnavailableError } from '../tv/glasshouse.js';
import { loadKnownTvs, relocateMovedTvs, saveTvClientKey } from '../tv/known-tvs.js';
import {
  sharedTvSessionPool,
  tvKey,
  tvKeys,
  tvRequest,
  tvScreenshot,
  tvToast,
  tvTypeText,
} from '../tv/lgtv.js';
import { tvPower } from '../tv/power.js';
import type { KnownTv } from '../tv/registry.js';
import { rokuDriver } from '../tv/roku.js';
import { samsungDriver, sharedSamsungPool } from '../tv/samsung.js';
import { deepLaunchPayload } from '../tv/search-recipes.js';
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

export interface TvToolDepsOptions {
  /**
   * Proceso largo (daemon, /tv en Telegram): reutiliza la conexión con la tele,
   * no repite la sonda de auto-selección si la tele acaba de contestar y no
   * reintenta Glasshouse durante un rato si no contestó.
   */
  keepAlive?: boolean;
}

/** Sin sonda de auto-selección si la tele activa contestó hace menos de esto. */
const RECENT_ANSWER_MS = 30_000;
/** Glasshouse inalcanzable: no se vuelve a probar (launch/toast/power van directos por SSAP) en este rato. */
export const GH_DOWN_RETRY_MS = 120_000;
const ghDownUntil = new Map<string, number>();
const ghClients = new Map<string, GlasshouseClient>();

/**
 * Cableado de la tool `tv` al cliente SSAP real.
 *
 * La emparejacion vive en el vault (tv:host / tv:clientKey / tv:secure), escrita
 * por `pa tv setup`. Si no hay pairing, TODAS las acciones fallan aqui con un
 * mensaje que el modelo puede leer, en vez de romper el arranque del agente: la
 * tele es opcional y su ausencia no puede tumbar el resto.
 */
export function tvToolDeps(store: Store, opts: TvToolDepsOptions = {}): TvToolDeps {
  // Daemon y /tv: conexión con la tele reutilizada entre órdenes (src/tv/lgtv.ts
  // TvSessionPool). `pa tv` (proceso corto) abre y cierra como siempre.
  const pool = opts.keepAlive ? sharedTvSessionPool() : null;
  const poolDep = pool ? { pool } : {};
  const frameDir = join(paths.screenshots, 'tv');
  mkdirSync(frameDir, { recursive: true });
  const STATE_KEY = 'tv:lastLook';
  // Apps de cada tele guardadas (memoria + kv): ver src/tv/app-cache.ts.
  const appCache = createTvAppCache({ store });
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
    // La activa contestó hace nada (sesión persistente): ni sonda TCP ni descubrimiento.
    const activeHost = pool ? await vaultGet('tv:host') : undefined;
    const recent = !!(pool && activeHost && pool.answeredWithin(activeHost, RECENT_ANSWER_MS));
    if (!recent) {
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
    }
    const activeBrand = await vaultGet('tv:activeBrand');
    if (activeBrand === 'roku' || activeBrand === 'samsung') {
      throw new Error(
        `La tele activa es ${activeBrand === 'roku' ? 'un Roku' : 'una Samsung'}: dale la orden en palabras (action=command, p. ej. "baja el volumen"); esta accion es de las LG.`,
      );
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
  const ghKeys = new WeakMap<GlasshouseClient, string>();
  const ghClient = async (): Promise<GlasshouseClient> => {
    // Orden a otra tele: Glasshouse solo en SU IP (si no esta rooteada, falla
    // como inalcanzable y se sigue por SSAP); nunca los endpoints de la activa.
    const target = currentTvTarget();
    let endpoints: string[];
    let token: string | undefined;
    if (target && target.host !== (await vaultGet('tv:host'))) {
      endpoints = [`http://${target.host}:8080`];
    } else {
      const override = await vaultGet('tv:glasshouseUrl');
      endpoints = override?.trim()
        ? override
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : GH_DEFAULT_ENDPOINTS;
      token = await vaultGet('tv:glasshouseToken');
    }
    if (!pool) return new GlasshouseClient({ endpoints, ...(token ? { token } : {}) });
    // Proceso largo: el mismo cliente entre órdenes (recuerda el endpoint que contestó).
    const key = `${endpoints.join(',')}|${token ?? ''}`;
    let client = ghClients.get(key);
    if (!client) {
      client = new GlasshouseClient({ endpoints, ...(token ? { token } : {}) });
      ghClients.set(key, client);
    }
    ghKeys.set(client, key);
    return client;
  };

  /**
   * Glasshouse con SSAP detrás (launch, toast, power): si hace poco no contestó
   * en ningún endpoint, no se vuelve a esperar sus timeouts (hasta 4 s por
   * endpoint) y se va directo por SSAP. Solo con keepAlive.
   */
  const ghOrSkip = async (run: (gh: GlasshouseClient) => Promise<unknown>): Promise<void> => {
    const gh = await ghClient();
    const key = ghKeys.get(gh);
    if (key && (ghDownUntil.get(key) ?? 0) > Date.now()) {
      throw new GlasshouseUnavailableError('Glasshouse no contestó hace poco; voy por SSAP.');
    }
    try {
      await run(gh);
      if (key) ghDownUntil.delete(key);
    } catch (err) {
      if (key && err instanceof GlasshouseUnavailableError) {
        ghDownUntil.set(key, Date.now() + GH_DOWN_RETRY_MS);
      }
      throw err;
    }
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
    // Roku y Samsung (nombrados, o la activa sin nombrar) van por su driver, nunca por SSAP.
    const activeTv = known.find((t) => t.host === active);
    const isOther = (t: KnownTv | undefined) => t?.brand === 'roku' || t?.brand === 'samsung';
    const tv = found.tv ?? (isOther(activeTv) ? activeTv : undefined);
    if (tv && isOther(tv)) {
      const other = tv;
      const driver =
        other.brand === 'roku'
          ? rokuDriver(other.host)
          : samsungDriver(
              { host: other.host, token: other.clientKey, secure: other.secure === '1' },
              {
                mac: other.mac,
                onToken: (key) => saveTvClientKey(other.host, key),
                // Daemon: la conexión se queda abierta entre órdenes (como la LG, #1891).
                pool: opts.keepAlive ? sharedSamsungPool() : null,
              },
            );
      return {
        text: found.text,
        label: tvTargetLabel(other),
        run: direct,
        intentRunner: (intent) => runIntentOnDriver(driver, intent),
      };
    }
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
        ...poolDep,
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
        { allowPlaintext, onNewClientKey: saveNewKey, ...poolDep },
      );
      const p = res as { appId?: string; appCategory?: string[] };
      return { appId: p.appId ?? 'desconocida', category: p.appCategory ?? [] };
    },
    apps: async (o) => {
      const { host, clientKey, allowPlaintext } = await paired();
      // Lista guardada por tele (src/tv/app-cache.ts): listLaunchPoints solo
      // cuando no hay una válida o se pide fresca.
      return appCache.get(
        host,
        async () => {
          const res = await tvRequest(
            host,
            clientKey,
            'com.webos.applicationManager/listLaunchPoints',
            {},
            { allowPlaintext, onNewClientKey: saveNewKey, ...poolDep },
          );
          const points =
            (res as { launchPoints?: { id: string; title: string }[] }).launchPoints ?? [];
          return points.map((p) => ({ id: p.id, title: p.title }));
        },
        o,
      );
    },
    forgetApps: async () => {
      const { host } = await paired();
      appCache.invalidate(host);
    },
    launch: async (id) => {
      // Glasshouse primero (sin pairing); si la tele no lo tiene o no
      // responde, SSAP con la client-key guardada.
      try {
        await ghOrSkip((gh) => gh.control('launchApp', id));
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
        { allowPlaintext, onNewClientKey: saveNewKey, ...poolDep },
      );
    },
    launchDeep: async (id, contentId) => {
      // Deeplinks solo por SSAP: Glasshouse no admite parámetros de contenido
      // y el payload documentado es { id, contentId } en system.launcher/launch.
      const { host, clientKey, allowPlaintext } = await paired();
      await tvRequest(
        host,
        clientKey,
        'system.launcher/launch',
        // YouTube lee params.contentTarget, no contentId (src/tv/search-recipes.ts).
        deepLaunchPayload(id, contentId),
        { allowPlaintext, onNewClientKey: saveNewKey, ...poolDep },
      );
    },
    launchParams: async (id, params) => {
      // Recetas de búsqueda por app: también solo por SSAP (Glasshouse no
      // pasa parámetros de arranque).
      const { host, clientKey, allowPlaintext } = await paired();
      await tvRequest(
        host,
        clientKey,
        'system.launcher/launch',
        { id, params },
        { allowPlaintext, onNewClientKey: saveNewKey, ...poolDep },
      );
    },
    guide: async (query) => {
      const { movistarFind } = await import('../tv/movistar.js');
      return movistarFind(query);
    },
    search: async (key) => {
      // Búsqueda universal de webOS (com.webos.service.unifiedsearch):
      // lectura pura, no cambia nada en la tele.
      const { host, clientKey, allowPlaintext } = await paired();
      return tvRequest(
        host,
        clientKey,
        'com.webos.service.unifiedsearch/search',
        { key },
        { allowPlaintext, onNewClientKey: saveNewKey, ...poolDep },
      );
    },
    key: async (name) => {
      const { host, clientKey, allowPlaintext } = await paired();
      await tvKey(host, clientKey, name, {
        allowPlaintext,
        onNewClientKey: saveNewKey,
        ...poolDep,
      });
    },
    keys: async (names) => {
      const { host, clientKey, allowPlaintext } = await paired();
      await tvKeys(host, clientKey, names, {
        allowPlaintext,
        onNewClientKey: saveNewKey,
        ...poolDep,
      });
    },
    typeText: async (text) => {
      const { host, clientKey, allowPlaintext } = await paired();
      await tvTypeText(host, clientKey, text, {
        allowPlaintext,
        onNewClientKey: saveNewKey,
        ...poolDep,
      });
    },
    toast: async (message) => {
      try {
        await ghOrSkip((gh) => gh.control('toast', message));
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
      await tvToast(host, clientKey, message, {
        allowPlaintext,
        onNewClientKey: saveNewKey,
        ...poolDep,
      });
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
          await ghOrSkip((gh) => gh.control(action));
        },
        ssap: async (uri, payload) => {
          const p = await paired();
          return tvRequest(p.host, p.clientKey, uri, payload, {
            allowPlaintext: p.allowPlaintext,
            onNewClientKey: saveNewKey,
            ...poolDep,
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
              ...poolDep,
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
          ...poolDep,
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
  tools: ({ store, staleOrder }) => [
    createTvTool({ ...tvToolDeps(store, { keepAlive: true }), staleOrder }),
  ],
};

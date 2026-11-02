import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Static } from 'typebox';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { log } from '../log.js';
import { APP_NAMES, needsAppLookup, type ResolvedApp, resolveAppId } from '../tv/apps.js';
import { inspectTv } from '../tv/inspection.js';
import { describeTvIntent, parseTvCommand, type TvIntent, tvOrderHasTime } from '../tv/natural.js';
import type { TvPowerOutcome } from '../tv/power.js';
import { resolveScene, runScene, summarizeScene, TV_SCENES } from '../tv/scenes.js';
import { appSearchRecipe, type TvSearchRecipe } from '../tv/search-recipes.js';
import { formatTvSearchResults } from '../tv/search-results.js';
import { describeTvStatus, type TvStatus } from '../tv/status.js';

/** Pantallas de inicio de webOS: «apagar todo» no las cierra (no son una app abierta). */
const HOME_APPS = new Set(['com.webos.app.home', 'com.webos.app.launcher']);

/**
 * Herramienta de la tele LG (SSAP).
 *
 * El agente ya controlaba el PC con una captura real; la tele estaba en un
 * limbo: podia lanzar apps y poner toasts, pero no VER nada, asi que cualquier
 * afirmacion sobre lo que hay en pantalla habia que comprobarla a ciegas.
 *
 * `screenshot` devuelve el frame al modelo con la MISMA forma que el computer
 * tool (ImageContent base64), de modo que puede leerlo con su propia vision sin
 * un pathway nuevo.
 */

/** Un frame de la tele casi vacio ronda los 9 kB; uno con contenido, 120-160 kB. */
export const SUSPECT_BLANK_BYTES = 24_000;

/** «a la mitad» sin Glasshouse va por teclas: tope para no tener la cola ocupada medio minuto. */
export const MAX_HALF_KEY_PRESSES = 25;

export interface TvMemoryState {
  /** appId en primer plano en el momento de mirar. */
  appId: string;
  category: string[];
  /** ISO. */
  at: string;
  framePath: string;
  bytes: number;
}

/**
 * Ruta de una orden en palabras cuando hay varias teles (src/tv/target.ts):
 * el texto sin la frase de lugar, quién la ejecuta (dentro del contexto de esa
 * tele) y, si no está claro a cuál, la pregunta en vez de tocar ninguna.
 */
export interface TvOrderRoute {
  text: string;
  ask?: string;
  /** Nombre de la tele nombrada, para la respuesta («Hecho (dormitorio)»). */
  label?: string;
  run: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Tele de otra marca (Roku...): ejecuta la orden entendida con su driver y da la frase. */
  intentRunner?: (intent: TvIntent) => Promise<string>;
}

export interface TvToolDeps {
  /** Varias teles: a cuál va una orden en palabras. Sin esto, siempre la activa. */
  routeOrder?: (text: string) => Promise<TvOrderRoute>;
  /** Frame actual de la tele. Lanza si no esta emparejada o apagada. */
  /** ext opcional: los mocks pueden omitirla (cae a jpg); el adapter real la deriva de la firma. */
  shot: () => Promise<{ image: Buffer; mimeType: string; ext?: string }>;
  foreground: () => Promise<{ appId: string; category: string[] }>;
  /**
   * Apps instaladas. La lista va guardada por tele (src/tv/app-cache.ts):
   * `fresh` la vuelve a pedir a la tele.
   */
  apps: (opts?: { fresh?: boolean }) => Promise<Array<{ id: string; title: string }>>;
  /** Tira la lista de apps guardada (un lanzamiento falló: puede estar vieja). */
  forgetApps?: () => Promise<void>;
  /**
   * Estado en vivo sin captura (src/tv/status.ts): energia, app/entrada y
   * volumen. Ausente = instalacion antigua: action=status lo dice.
   */
  status?: () => Promise<TvStatus>;
  /** Glasshouse GET /api/stats, optional for older installations. */
  stats?: () => Promise<unknown>;
  launch: (id: string) => Promise<void>;
  // Deeplink con contenido (Netflix «m=https://www.netflix.com/watch/ID»,
  // YouTube «v=VIDEO_ID»): va por SSAP system.launcher/launch directo.
  launchDeep?: (id: string, contentId: string) => Promise<void>;
  // Arranque con parámetros (system.launcher/launch {id, params}): las
  // recetas de búsqueda por app (src/tv/search-recipes.ts), p. ej. YouTube.
  launchParams?: (id: string, params: Record<string, string>) => Promise<void>;
  // Búsqueda universal de webOS (apps y contenido registrado). Solo lectura.
  search?: (key: string) => Promise<unknown>;
  // Guía pública de Movistar Plus+: qué echan y en qué canal (sin login).
  guide?: (query: string) => Promise<
    Array<{
      channelName: string;
      title: string;
      desc: string;
      start: Date;
      stop: Date;
      live: boolean;
    }>
  >;
  /**
   * Ráfaga de teclas por UNA conexión (src/tv/lgtv.ts tvKeys). Sin ella, la
   * tool encadena `key` una a una (mismo resultado, mucho más lento).
   */
  keys?: (names: string[]) => Promise<void>;
  /**
   * Escribe el texto entero en el campo enfocado de la tele (SSAP IME).
   * Ausente = instalación antigua: action=type lo dice y sugiere las teclas.
   */
  typeText?: (text: string) => Promise<void>;
  /**
   * Aviso si el mensaje que originó este turno es viejo (src/tv/stale-order.ts):
   * entonces nada que mueva la tele se ejecuta. Ausente = siempre en vivo.
   */
  staleOrder?: () => string | null;
  key: (name: string) => Promise<void>;
  toast: (message: string) => Promise<void>;
  /**
   * Encender/apagar. Puede devolver como llego la orden (src/tv/power.ts): con
   * Wake-on-LAN la tool dice si la tele ya responde; sin resultado, el texto de
   * siempre (orden enviada, sin confirmar).
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: los adapters y mocks existentes devuelven Promise<void>
  power: (on: boolean) => Promise<void | TvPowerOutcome>;
  /**
   * Control via Glasshouse (API HTTP :8080 de la tele rooteada): volumen
   * absoluto, inputs, url, picture, adblock y privacidad - lo que SSAP no
   * alcanza. Ausente = Glasshouse no configurado: esas acciones fallan con
   * mensaje claro, el resto sigue por SSAP.
   */
  ghControl?: (action: string, value?: string | number | boolean) => Promise<void>;
  /** Guarda el frame en disco y devuelve la ruta (queda como ultimo estado). */
  saveFrame: (bytes: Buffer, ext?: string) => string;
  getState: () => TvMemoryState | null;
  setState: (state: TvMemoryState) => void;
}

const Params = lazySchema(() =>
  Type.Object({
    action: Type.Union([
      Type.Literal('screenshot'),
      Type.Literal('state'),
      Type.Literal('status'),
      Type.Literal('apps'),
      Type.Literal('inspect'),
      Type.Literal('launch'),
      Type.Literal('search'),
      Type.Literal('guide'),
      Type.Literal('key'),
      Type.Literal('type'),
      Type.Literal('toast'),
      Type.Literal('power'),
      Type.Literal('volume'),
      Type.Literal('mute'),
      Type.Literal('input'),
      Type.Literal('url'),
      Type.Literal('closeApp'),
      Type.Literal('screen'),
      Type.Literal('media'),
      Type.Literal('adblock'),
      Type.Literal('adTracking'),
      Type.Literal('volumeStep'),
      Type.Literal('volumeHalf'),
      Type.Literal('channel'),
      Type.Literal('command'),
      Type.Literal('scene'),
      Type.Literal('picture'),
    ]),
    appId: Type.Optional(
      Type.String({
        description:
          'Para launch: el id de la app (sacalo de action=apps) o su nombre ("Netflix", "YouTube", "Disney+"): se resuelve al id instalado. Para search: busca DENTRO de esa app (YouTube, Netflix: directo, sin teclado).',
      }),
    ),
    contentId: Type.Optional(
      Type.String({
        description:
          'Para launch: deeplink al contenido exacto. Netflix: "m=https://www.netflix.com/watch/ID" (el ID sale de la URL del título). YouTube: "v=VIDEO_ID". Otras apps no lo documentan.',
      }),
    ),
    name: Type.Optional(
      Type.String({
        description: 'Para key: HOME, BACK, ENTER, LEFT, RIGHT, UP, DOWN, VOLUP, VOLDOWN.',
      }),
    ),
    names: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Para key: varias teclas seguidas por UNA conexión (navegar menús mucho más rápido), p.ej. ["RIGHT","RIGHT","DOWN","ENTER"]. Máx 40. Si está, se ignora name.',
      }),
    ),
    look: Type.Optional(
      Type.Boolean({
        description:
          'Para key/type/search con appId: true devuelve además una captura de la tele tras la acción, para verificar dónde quedó el foco sin gastar otro turno. Por defecto true en ráfagas y type, false en una tecla suelta.',
      }),
    ),
    message: Type.Optional(Type.String({ description: 'Para toast: el texto a mostrar.' })),
    on: Type.Optional(
      Type.Boolean({
        description:
          'Para power/screen/mute/adTracking: true enciende/activa, false apaga/desactiva.',
      }),
    ),
    level: Type.Optional(
      Type.Number({ description: 'Para volume: nivel absoluto, entero 0-100.' }),
    ),
    input: Type.Optional(
      Type.String({ description: 'Para input: hdmi1, hdmi2, hdmi3, hdmi4 o tv.' }),
    ),
    url: Type.Optional(
      Type.String({ description: 'Para url: pagina http(s) a abrir en el navegador de la tele.' }),
    ),
    command: Type.Optional(
      Type.String({
        description: 'Para media: play, pause, playPause, stop, rewind o fastForward.',
      }),
    ),
    steps: Type.Optional(
      Type.Number({
        description:
          'Para volumeStep: pasos relativos del mando, entero -15..15 sin 0 ("sube un poco" = 3, "baja 5" = -5). Va por SSAP, no necesita Glasshouse.',
      }),
    ),
    channel: Type.Optional(
      Type.String({ description: 'Para channel: up, down o el numero del canal (1-9999).' }),
    ),
    scene: Type.Optional(
      Type.String({
        description:
          'Para scene: la rutina. "cine" (enciende si hace falta, quita el silencio, volumen 20 o level, abre appId si se pide y muestra un aviso); "noche" (volumen 8 o level y aviso, sin encender una tele apagada); "apagar-todo" (aviso y apagar la tele si esta encendida).',
      }),
    ),
    text: Type.Optional(
      Type.String({
        description:
          'Para command: la orden tal cual en castellano ("apaga la tele", "abre Netflix", "volumen a 20", "canal 5", "sube el volumen", "silencio", "pausa", "pon el HDMI 2", "que esta viendo"). Para type: el texto a escribir de una vez en el campo enfocado de la tele (buscadores, máx 200): mucho más rápido que teclear letra a letra con key.',
      }),
    ),
    pictureMode: Type.Optional(
      Type.String({
        description:
          'Para picture: modo de imagen de LG (standard, eco, cinema, vivid, sports, game, filmMaker...). «Pon la imagen en estandar» = standard.',
      }),
    ),
    mode: Type.Optional(
      Type.String({
        description:
          'Para adblock: off (nada), ads (publi y telemetria) o full (tambien tienda/updates LG).',
      }),
    ),
  }),
);

const KEYS = [
  'HOME',
  'BACK',
  'EXIT',
  'ENTER',
  'LEFT',
  'RIGHT',
  'UP',
  'DOWN',
  'VOLUP',
  'VOLDOWN',
  'MUTE',
  'RED',
  'GREEN',
  'YELLOW',
  'BLUE',
] as const;

/** Alias publicos -> nombre SSAP real (la whitelist de lgtv.ts manda). */
const KEY_ALIASES: Record<string, string> = {
  VOLUP: 'VOLUMEUP',
  VOLDOWN: 'VOLUMEDOWN',
};

/**
 * Cola de mutaciones TV compartida por TODOS los agentes del proceso: las
 * acciones que cambian el estado de la tele van de una en una (dos agentes
 * no se pisan). Las lecturas no pasan por aqui: mirar la tele no bloquea el PC.
 */
let tvMutationQueue: Promise<void> = Promise.resolve();

let lastTvOrderAt: number | null = null;

/** Hora (ms) de la última orden a la tele que salió bien, por cualquier vía (modelo, /tv, atajo). */
export function tvLastOrderAt(): number | null {
  return lastTvOrderAt;
}

function enqueueTvMutation<T>(fn: () => Promise<T>): Promise<T> {
  const timed = async (): Promise<T> => {
    const out = await fn();
    lastTvOrderAt = Date.now();
    return out;
  };
  const run = tvMutationQueue.then(timed, timed);
  tvMutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const TV_INPUTS = ['hdmi1', 'hdmi2', 'hdmi3', 'hdmi4', 'tv'] as const;
const MEDIA_COMMANDS = ['play', 'pause', 'playPause', 'stop', 'rewind', 'fastForward'] as const;
const ADBLOCK_MODES = ['off', 'ads', 'full'] as const;

/** Acciones que SOLO existen via Glasshouse: sin cliente configurado, error claro. */
function needGh(
  deps: TvToolDeps,
): (action: string, value?: string | number | boolean) => Promise<void> {
  if (!deps.ghControl) {
    throw new Error(
      'Esta accion va por Glasshouse (la app de la tele rooteada, :8080) y no esta configurado. ' +
        'Las acciones SSAP (screenshot, apps, launch, key, toast, power) siguen disponibles.',
    );
  }
  return deps.ghControl;
}

export function createTvTool(deps: TvToolDeps): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'tv',
    label: 'Televisor LG',
    description: [
      'Mira y controla el televisor LG de la casa, que esta emparejada por SSAP.',
      '',
      'action=screenshot es lo importante: devuelve la pantalla de la tele ahora mismo, 960x540.',
      'Usalo ANTES de actuar sobre la tele, igual que computer action=screenshot antes de tocar el PC:',
      'lanzar una app a ciegas es la forma rapida de dejar al usuario con una pantalla que no entiende.',
      '',
      'action=state devuelve lo que la tele mostraba la ULTIMA vez que se miro, sin despertarla:',
      'sirve para responder "que estaba viendo" sin gastar una captura. No confirma nada del presente.',
      '',
      'action=status mira la tele EN VIVO sin captura ni cambiar nada: si esta encendida, en reposo o no responde,',
      'que app o entrada (HDMI) tiene delante y el volumen. Para "esta encendida?" o "que esta viendo?" usa esto antes que screenshot.',
      '',
      'action=inspect consulta inventario, app actual y metricas disponibles SIN cambiar la tele ni capturar imagenes.',
      'Es una lectura puntual no atomica: no mide mejoras ni certifica que una app se pueda borrar.',
      'Un dato no disponible NO significa cero, tele apagada ni lista de apps vacia.',
      'action=apps lista los ids y titulos instalados (los nuestras tienen id tipo org.webosbrew.hbchannel).',
      '',
      'LA TELE DE NICO (webOS rooteada): el Home NO es el de LG. Tiene el "Home de Nico"',
      '(app tld.my.customhome, hecho por nosotros) que sustituye al launcher; un watcher',
      '(homehook) lo reabre si el Home de LG pasa al frente, asi que la tecla HOME lleva a',
      'SU Home, no al de LG. Su pantalla: arriba "Para ti" (recomendaciones TMDB; OK abre',
      'la app del proveedor), abajo un dock de iconos (OK abre, Back pregunta si salir al',
      'Home de LG, OK largo reordena). Para abrir una app NO navegues el Home a ciegas:',
      'usa action=launch con el id, que es directo y no depende de donde este el foco.',
      'Ids verificados en SU tele: Netflix=netflix, Movistar Plus+=com.telefonica.app.nux,',
      'Nuvio TV=space.nuvio.webos, YouTube AdFree=org.webosbrew.youtube.adfree (su YouTube,',
      'sin anuncios), IBO Player=iboplayer.lg, Moonlight=com.limelight.webos,',
      'Asistenta=com.tvweb.dashboard. com.webos.app.home es el Home de LG (casi nunca lo',
      'querra; si sale, el homehook lo tapa solo al instante).',
      'action=launch arranca una app, action=key pulsa el mando, action=toast muestra un aviso,',
      'action=power apaga o enciende (si esta apagada del todo y hay MAC guardada, por red).',
      'action=type escribe texto en el campo enfocado (buscadores); key con names es una rafaga de teclas.',
      'Rafagas y type devuelven una captura de la tele (look=true por defecto): mirala para verificar',
      'donde quedo el foco ANTES de seguir o de dar algo por hecho; navegar a ciegas falla.',
      'Para buscar contenido (Netflix, Movistar Plus+, YouTube), EN ESTE ORDEN: 1) action=search',
      '(invisible; con appId busca dentro de esa app, YouTube/Netflix sin teclado); 2) si sabes el titulo exacto, launch con contentId (YouTube:',
      'v=VIDEO_ID; el ID lo sacas de una busqueda web); 3) solo si las otras no valen: screenshot,',
      'rafaga hasta el buscador, type, ENTER, verificando con la captura. OJO: apps con teclado propio',
      '(YouTube) pueden NO aceptar type: si el texto no aparece en la captura, no reintentes type,',
      'cambia de via. Y si una via falla, prueba la siguiente SIN PREGUNTAR: nunca devuelvas la tarea',
      'al usuario ("buscalo tu", "prefieres A o B?") pudiendo probar otra via tu mismo.',
      'action=launch con contentId abre el contenido exacto de una vez (Netflix/YouTube, ver contentId).',
      'action=search busca texto en la búsqueda universal de la tele (apps y contenido registrado),',
      'sin tocar nada; lo que devuelve depende de lo que cada app registre en webOS.',
      'action=guide con text dice QUÉ ECHAN en Movistar Plus+ y en qué canal (fuente pública, sin',
      'login): úsala cuando pidan un partido, una peli o un programa de Movistar. Luego para verlo:',
      'abre la app con launch y busca el CANAL por su nombre exacto con type, verificando con look.',
      'action=volumeHalf lee el volumen real y lo deja en la mitad (nunca sube; si no puede leerlo, no toca nada).',
      'action=volumeStep sube/baja el volumen por pasos del mando (steps), action=channel cambia de canal (up/down/numero).',
      'action=command entiende una orden natural en castellano (text) y la ejecuta: "apaga la tele", "abre Netflix",',
      '"volumen a 20", "canal 5", "sube el volumen", "silencio", "pausa", "pon el HDMI 2". Si no la entiende, lo dice.',
      'Con varias teles, nombra cual en la orden ("apaga la tele del dormitorio"); sin nombre va a la activa.',
      'action=scene scene=cine es el "modo cine": encender si hace falta, quitar silencio, volumen (level, por defecto 20),',
      'abrir la app que pidan (appId, p.ej. Netflix) y un aviso; devuelve el resultado de cada paso.',
      'scene=noche baja el volumen (level, por defecto 8) sin encender; scene=apagar-todo avisa y apaga la tele.',
      'Via Glasshouse (si esta configurado): action=volume con level (0-100, nivel absoluto - "sube el',
      'volumen a 13" es volume level=13), action=mute, action=input (hdmi1-4/tv), action=url (abrir web),',
      'action=closeApp, action=screen (panel negro con audio), action=media (play/pause/stop...),',
      'action=adblock (off/ads/full) y action=adTracking (limitar seguimiento).',
      '',
      'LIMITE IMPORTANTE: el contenido con DRM (Netflix, Prime, Disney+, DAZN, Max) puede salir en',
      'NEGRO (LG bloquea la captura de video protegido en TVs de 2020 en adelante), pero un frame',
      'negro o minusculo NO prueba DRM ni que la tele este apagada: el tamano comprimido no es',
      'evidencia concluyente. Afirma solo lo que veas en la imagen; si no se ve, dilo y ya.',
      'action=power envia la ORDEN (encender pantalla o apagar) sin confirmacion del estado fisico:',
      'encender no arranca una tele apagada del todo (sin SSAP no llega nada).',
    ].join(' '),
    parameters: Params(),
    // Sequential: two captures in one batch can straddle a repaint and report a
    // screen state that no longer exists, same reason as the ocr tool.
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const stale = TV_READ_ONLY.has(args.action) ? null : (deps.staleOrder?.() ?? null);
      if (stale) {
        log.info('tv: orden de un mensaje viejo, no se ejecuta', { action: args.action });
        return { content: [{ type: 'text', text: stale }], details: { skipped: 'stale' } };
      }
      try {
        return await runTvAction(deps, args);
      } catch (err) {
        throw explainTvError(err);
      }
    },
  };
}

type TvArgs = Static<ReturnType<typeof Params>>;

/** Acciones que solo miran la tele: un mensaje viejo puede seguir pidiéndolas. */
const TV_READ_ONLY: ReadonlySet<string> = new Set([
  'screenshot',
  'state',
  'status',
  'apps',
  'inspect',
]);

/**
 * Los errores de transporte llegan tecnicos ("No se pudo conectar... (no
 * abre)", "La TV rechazo ...: 401"). Aqui se les antepone QUE significa para
 * el usuario y que hacer, en castellano, sin perder el detalle original (que
 * sigue en el mensaje) ni la clase del error (se reescribe el message).
 */
export function explainTvError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const msg = err.message;
  let hint: string | null = null;
  if (err.name === 'TvUnreachableError' || /No se pudo conectar con la TV/.test(msg)) {
    hint = 'No llego a la tele: parece apagada del todo o fuera de la red.';
  } else if (
    err.name === 'GlasshouseAmbiguousError' ||
    err.constructor?.name === 'GlasshouseAmbiguousError'
  ) {
    hint =
      'La orden salio pero la tele no contesto: puede que se haya aplicado. No la repito para no duplicarla; mira la tele o usa action=status.';
  } else if (/La TV rechazo el registro|401|insufficient permissions/i.test(msg)) {
    hint =
      'La tele ya no reconoce a Asistenta (emparejamiento revocado). Hay que volver a emparejar: pa tv setup <ip>.';
  } else if (/not permitted|rechazo .*: .*denied/i.test(msg)) {
    hint = 'La tele ha rechazado la orden (no lo permite en este momento o sin ese permiso).';
  } else if (/no respondio|timeout/i.test(msg)) {
    hint =
      'La tele tarda demasiado en contestar (ocupada o arrancando). Prueba otra vez en unos segundos.';
  }
  if (hint && !msg.startsWith(hint)) {
    err.message = `${hint} Detalle: ${msg}`;
  }
  return err;
}

interface TvFrame {
  state: TvMemoryState;
  blank: boolean;
  lines: string[];
  imageBlock: { type: 'image'; mimeType: string; data: string };
}

// Dispara la captura y actualiza la memoria de la sesión. La app se lee
// DESPUÉS del disparo (ventana menor), pero ni así es pareja atómica con el
// frame: otra acción puede cambiarla entre ambas.
async function captureFrame(deps: TvToolDeps): Promise<TvFrame> {
  const { image, mimeType, ext = 'jpg' } = await deps.shot();
  const fg = await deps.foreground().catch(() => null);
  const path = deps.saveFrame(image, ext);
  const state: TvMemoryState = {
    appId: fg?.appId ?? 'desconocida',
    category: fg?.category ?? [],
    at: new Date().toISOString(),
    framePath: path,
    bytes: image.length,
  };
  deps.setState(state);
  const blank = image.length < SUSPECT_BLANK_BYTES;
  const lines = [
    `Tele 960x540 (${image.length} bytes).`,
    fg
      ? `App en primer plano al terminar la captura: ${fg.appId}${fg.category.length ? ` (${fg.category.join(', ')})` : ''} (lectura no atomica con el frame).`
      : 'No he podido leer la app en primer plano.',
    `Guardado en ${path}.`,
  ];
  if (blank) {
    lines.push(
      'AVISO: el frame comprimido es mucho mas pequeno de lo habitual. Puede ser una ' +
        'pantalla oscura, una app con poco contenido o video protegido (DRM): el tamano ' +
        'NO lo prueba. No deduzcas el estado de la tele ni lo que se ve de este dato.',
    );
  }
  return {
    state,
    blank,
    lines,
    imageBlock: { type: 'image', mimeType, data: image.toString('base64') },
  };
}

// Versión corta para adjuntar la captura tras una ráfaga o un type: la tele
// se ve sin gastar otro turno y el modelo verifica dónde quedó el foco.
function frameSummary(frame: TvFrame): string {
  const base = `Captura tras la acción: app ${frame.state.appId} (${frame.state.bytes} bytes).`;
  return frame.blank
    ? `${base} AVISO: frame muy pequeño (pantalla oscura o DRM); no deduzcas lo que se ve de este dato.`
    : base;
}

/** Nombre o id → id real; la lista guardada se vuelve a pedir si el nombre no está en ella. */
async function resolveTvApp(deps: TvToolDeps, asked: string): Promise<ResolvedApp> {
  if (!needsAppLookup(asked)) return resolveAppId(asked, null);
  // "Netflix", "youtube" o "RTVE Play" -> id real. La lista va guardada por
  // tele: solo se vuelve a pedir si el nombre no aparece (app recién instalada).
  const installed = await deps.apps().catch(() => null);
  const first = resolveAppId(asked, installed);
  if (first.how !== 'raw' || !installed) return first;
  const fresh = await deps.apps({ fresh: true }).catch(() => null);
  return fresh ? resolveAppId(asked, fresh) : first;
}

/**
 * Búsqueda directa dentro de una app (receta de src/tv/search-recipes.ts):
 * una sola orden a la tele y la captura de después para comprobarlo.
 * null si esta instalación no sabe hacerlo (sigue la búsqueda universal).
 */
async function searchInApp(
  deps: TvToolDeps,
  recipe: Exclude<TvSearchRecipe, { kind: 'keyboard' }>,
  query: string,
  look: boolean,
): Promise<AgentToolResult<Record<string, unknown>> | null> {
  const launchParams = deps.launchParams;
  const launchDeep = deps.launchDeep;
  if (recipe.kind === 'params' && !launchParams) return null;
  if (recipe.kind === 'contentId' && !launchDeep) return null;
  const frames: TvFrame[] = [];
  await enqueueTvMutation(async () => {
    if (recipe.kind === 'params') await launchParams?.(recipe.appId, recipe.params);
    else await launchDeep?.(recipe.appId, recipe.contentId);
    if (look) {
      const shot = await captureFrame(deps).catch(() => null);
      if (shot) frames.push(shot);
    }
  });
  const frame = frames[0];
  const content: Array<
    { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
  > = [
    {
      type: 'text' as const,
      text:
        `He abierto ${recipe.app} buscando «${query}» directamente, sin teclado. ` +
        'Comprueba en la captura que salen resultados; si no, sigue con la vía siguiente SIN PREGUNTAR.',
    },
  ];
  if (frame) content.push({ type: 'text' as const, text: frameSummary(frame) }, frame.imageBlock);
  return {
    content,
    details: {
      query,
      appId: recipe.appId,
      recipe: recipe.kind,
      verified: false,
      ...(frame ? { ...frame.state, blank: frame.blank } : {}),
    },
  };
}

async function runTvAction(
  deps: TvToolDeps,
  args: TvArgs,
): Promise<AgentToolResult<Record<string, unknown>>> {
  switch (args.action) {
    case 'screenshot': {
      // La captura entera va por la MISMA cola que las mutaciones: dos
      // agentes nunca intercalan key/shot (auditor: key-start,shot,key-end).
      return enqueueTvMutation(async () => {
        const frame = await captureFrame(deps);
        log.info('tv screenshot', { appId: frame.state.appId, bytes: frame.state.bytes });
        return {
          content: [{ type: 'text' as const, text: frame.lines.join(' ') }, frame.imageBlock],
          details: { ...frame.state, blank: frame.blank },
        };
      });
    }
    case 'search': {
      // Búsqueda universal de webOS: solo lectura, nada cambia en la tele.
      const key = (args.text ?? '').trim();
      if (!key) throw new Error('action=search necesita text: lo que se busca en la tele.');
      // Con appId: la receta de búsqueda de ESA app (YouTube, Netflix,
      // Movistar Plus+) en vez de la búsqueda universal.
      let hint = '';
      const askedApp = (args.appId ?? '').trim();
      if (askedApp) {
        const app = await resolveTvApp(deps, askedApp);
        const recipe = appSearchRecipe(app.id, key);
        if (recipe && recipe.kind !== 'keyboard') {
          const direct = await searchInApp(deps, recipe, key, args.look ?? true);
          if (direct) return direct;
        }
        hint =
          recipe?.kind === 'keyboard'
            ? recipe.hint
            : `${app.title ?? APP_NAMES[app.id] ?? askedApp} no tiene receta de búsqueda directa: si esto no vale, usa su buscador con key/type verificando con la captura.`;
        if (!deps.search) throw new Error(hint);
      }
      if (!deps.search) {
        throw new Error(
          'Esta instalación no tiene la búsqueda universal de la tele: usa key/type sobre el buscador de la app.',
        );
      }
      const raw = await deps.search(key);
      return {
        content: [
          {
            type: 'text' as const,
            text: hint
              ? `${formatTvSearchResults(key, raw)}\n${hint}`
              : formatTvSearchResults(key, raw),
          },
        ],
        details: { query: key, results: raw as Record<string, unknown> },
      };
    }
    case 'guide': {
      // Qué echan en Movistar Plus+: fuente pública, la tele no se entera.
      const query = (args.text ?? '').trim();
      if (!query)
        throw new Error('action=guide necesita text: el partido, peli o programa a buscar.');
      if (!deps.guide) {
        throw new Error(
          'Esta instalación no tiene la guía de Movistar Plus+: pregunta qué quieren ver y busca el canal a mano.',
        );
      }
      const matches = await deps.guide(query);
      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No encuentro «${query}» en la parrilla de Movistar Plus+ de las próximas 48 horas.`,
            },
          ],
          details: { query, matches: 0 },
        };
      }
      const fmt = (d: Date) =>
        d.toLocaleString('es-ES', {
          timeZone: 'Europe/Madrid',
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
      const lines = matches.map((m) => {
        const cuando = m.live
          ? `AHORA (hasta ${m.stop.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })})`
          : `${fmt(m.start)} a ${m.stop.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' })}`;
        return `«${m.title}» en ${m.channelName}, ${cuando}.`;
      });
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `En Movistar Plus+: ${lines.join(' ')} ` +
              'Para verlo: abre Movistar Plus+ con action=launch appId=com.telefonica.app.nux (si está instalada) ' +
              'y busca el canal por su nombre con type, verificando con la captura; si el teclado no acepta type, ' +
              'prueba action=search, SIN PREGUNTAR.',
          },
        ],
        details: {
          query,
          matches: matches.map((m) => ({
            canal: m.channelName,
            titulo: m.title,
            empieza: m.start.toISOString(),
            acaba: m.stop.toISOString(),
            enEmision: m.live,
          })),
        },
      };
    }
    case 'state': {
      const state = deps.getState();
      if (!state) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Nunca he mirado la tele en esta sesion. Usa action=screenshot para mirarla de verdad.',
            },
          ],
          details: { known: false },
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `La ultima vez que mire la tele (${state.at}) tenia ${state.appId} en primer plano. ` +
              `Frame en ${state.framePath} (${state.bytes} bytes). Esto es un recuerdo, no el presente: ` +
              `si importa, action=screenshot.`,
          },
        ],
        details: { known: true, ...state },
      };
    }
    case 'status': {
      if (!deps.status) {
        throw new Error(
          'action=status no esta disponible en esta instalacion: usa action=screenshot.',
        );
      }
      const st = await deps.status();
      return {
        content: [{ type: 'text' as const, text: describeTvStatus(st) }],
        details: { ...st },
      };
    }
    case 'inspect': {
      const report = await inspectTv(deps);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report) }],
        details: report,
      };
    }
    case 'apps': {
      const list = await deps.apps();
      const text = list.length
        ? list.map((a) => `${a.id}\t${a.title}`).join('\n')
        : 'La tele no devuelve apps instaladas.';
      return { content: [{ type: 'text' as const, text }], details: { count: list.length } };
    }
    case 'launch': {
      const asked = (args.appId ?? '').trim();
      if (!asked) throw new Error('action=launch necesita appId (miralos con action=apps).');
      // "Netflix", "youtube" o "RTVE Play" -> id real. Solo se pide la lista
      // a la tele cuando hace falta (ni ids reales ni alias conocidos).
      const resolved = await resolveTvApp(deps, asked);
      const appId = resolved.id;
      const contentId = (args.contentId ?? '').trim();
      if (contentId) {
        if (!deps.launchDeep) {
          throw new Error(
            'Esta instalación no sabe abrir deeplinks todavía: abre la app con action=launch y navega con key/type.',
          );
        }
        await enqueueTvMutation(() => deps.launchDeep?.(appId, contentId) ?? Promise.resolve());
        return {
          content: [
            {
              type: 'text' as const,
              text: `He abierto ${resolved.title ?? APP_NAMES[appId] ?? asked} directamente en ese contenido. Verifícalo con la captura (look o action=screenshot).`,
            },
          ],
          details: { appId, contentId },
        };
      }
      await enqueueTvMutation(() => deps.launch(appId)).catch(async (err) => {
        // La lista guardada pudo quedarse vieja (app desinstalada o con otro id).
        await deps.forgetApps?.().catch(() => {});
        throw err;
      });
      // A la persona, el nombre de la app; el id técnico (youtube.leanback.v4) va en details.
      const label = resolved.title ?? APP_NAMES[appId] ?? asked;
      return {
        content: [{ type: 'text' as const, text: `He abierto ${label} en la tele.` }],
        details: {
          appId,
          verified: false,
          ...(appId !== asked ? { asked, resolvedBy: resolved.how } : {}),
        },
      };
    }
    case 'volumeStep': {
      const steps = args.steps;
      if (
        typeof steps !== 'number' ||
        !Number.isInteger(steps) ||
        steps === 0 ||
        Math.abs(steps) > 15
      ) {
        throw new Error('action=volumeStep necesita steps: entero entre -15 y 15, distinto de 0.');
      }
      const key = steps > 0 ? 'VOLUMEUP' : 'VOLUMEDOWN';
      // Una sola entrada en la cola: nadie intercala teclas a mitad.
      await enqueueTvMutation(async () => {
        for (let i = 0; i < Math.abs(steps); i += 1) await deps.key(key);
      });
      const n = Math.abs(steps);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Volumen ${steps > 0 ? 'subido' : 'bajado'} ${n} paso${n === 1 ? '' : 's'} (sin confirmación de la tele).`,
          },
        ],
        details: { steps, verified: false },
      };
    }
    case 'volumeHalf': {
      // Nunca sube: lee el volumen REAL y baja a floor(v/2). Sin lectura no
      // se toca nada (bajar a ciegas podria dejarla muda o, peor, nada).
      const readVolume = async (): Promise<number | null> => {
        const st = await deps.status?.().catch(() => null);
        const v = st?.volume;
        return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
      };
      if (!deps.status) {
        throw new Error(
          'No puedo leer el volumen de la tele en esta instalacion, asi que no lo toco. Dime "volumen a N" o "baja N".',
        );
      }
      return enqueueTvMutation(async () => {
        const current = await readVolume();
        if (current === null) {
          throw new Error(
            'No se a que volumen esta la tele (puede estar apagada o no responde), asi que no lo toco. Dime "volumen a N" o "baja N".',
          );
        }
        const target = Math.floor(current / 2);
        if (target >= current) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `El volumen ya esta en ${current}: no lo bajo mas.`,
              },
            ],
            details: { from: current, to: current, verified: true },
          };
        }
        let via: 'glasshouse' | 'keys' = 'keys';
        let from = current;
        if (deps.ghControl) {
          try {
            await deps.ghControl('volume', target);
            via = 'glasshouse';
          } catch {
            // Glasshouse no contesto: puede que SI se aplicara. Se relee y
            // solo se baja lo que falte con el mando (bajar nunca sube).
            const again = await readVolume();
            if (again !== null && again <= target) {
              return {
                content: [
                  { type: 'text' as const, text: `Volumen bajado de ${current} a ${again}.` },
                ],
                details: { from: current, to: again, via: 'glasshouse', verified: true },
              };
            }
            if (again !== null) from = again;
          }
        }
        if (via === 'glasshouse') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Volumen bajado a la mitad: de ${current} a ${target}.`,
              },
            ],
            details: { from: current, to: target, via, verified: false },
          };
        }
        const want = from - target;
        const presses = Math.min(want, MAX_HALF_KEY_PRESSES);
        for (let i = 0; i < presses; i += 1) await deps.key('VOLUMEDOWN');
        const to = from - presses;
        return {
          content: [
            {
              type: 'text' as const,
              text:
                presses < want
                  ? `Volumen bajado ${presses} pasos con el mando (de ${current} a unos ${to}); para seguir bajando dime "baja N" o "volumen a ${target}".`
                  : `Volumen bajado a la mitad con el mando: de ${current} a ${target} (sin confirmación de la tele).`,
            },
          ],
          details: { from: current, to, via, presses, verified: false },
        };
      });
    }
    case 'channel': {
      const raw = (args.channel ?? '').trim().toLowerCase();
      let keys: string[];
      if (raw === 'up' || raw === 'arriba' || raw === 'siguiente') keys = ['CHANNELUP'];
      else if (raw === 'down' || raw === 'abajo' || raw === 'anterior') keys = ['CHANNELDOWN'];
      else if (/^\d{1,4}$/.test(raw) && Number(raw) > 0) keys = [...String(Number(raw)), 'ENTER'];
      else
        throw new Error('action=channel necesita channel: up, down o un numero de canal (1-9999).');
      await enqueueTvMutation(async () => {
        for (const k of keys) await deps.key(k);
      });
      const what =
        keys[0] === 'CHANNELUP'
          ? 'siguiente canal'
          : keys[0] === 'CHANNELDOWN'
            ? 'canal anterior'
            : `canal ${Number(raw)}`;
      return {
        content: [
          { type: 'text' as const, text: `He puesto el ${what} (sin confirmación de la tele).` },
        ],
        details: { channel: raw, keys, verified: false },
      };
    }
    case 'scene': {
      const key = resolveScene(args.scene ?? args.name ?? '');
      const def = key ? TV_SCENES[key] : undefined;
      if (!def) {
        throw new Error(`action=scene necesita scene: ${Object.keys(TV_SCENES).join(', ')}.`);
      }
      const level = args.level;
      if (level !== undefined && (!Number.isInteger(level) || level < 0 || level > 100)) {
        throw new Error('action=scene: level tiene que ser un entero 0-100.');
      }
      const appId = (args.appId ?? '').trim() || undefined;
      const steps = def.build({ appId, level });
      const results = await runScene(steps, {
        hasGlasshouse: Boolean(deps.ghControl),
        isOn: deps.status ? async () => (await deps.status?.())?.power === 'encendida' : undefined,
        exec: async (step) => {
          // Cada paso con su explicacion en castellano, como una accion suelta.
          let stepArgs: TvArgs;
          if (step.action === 'closeForeground') {
            const fg = await deps.foreground();
            const open = (fg.appId ?? '').trim();
            if (!open || HOME_APPS.has(open)) return 'no habia ninguna app abierta';
            stepArgs = { action: 'closeApp', appId: open } as TvArgs;
          } else if (step.action === 'picture') {
            stepArgs = { action: 'picture', pictureMode: step.mode } as TvArgs;
          } else {
            stepArgs = step as TvArgs;
          }
          const res = await runTvAction(deps, stepArgs).catch((err: unknown) => {
            throw explainTvError(err);
          });
          return res.content
            .map((c) => (c.type === 'text' ? c.text : ''))
            .join(' ')
            .trim();
        },
      });
      return {
        content: [
          { type: 'text' as const, text: summarizeScene(def.label, results, steps.length) },
        ],
        details: {
          scene: key,
          steps: results.map((r) => ({ action: r.step.action, status: r.status })),
          complete: results.length === steps.length,
          failed: results.filter((r) => r.status === 'fallo').length,
        },
      };
    }
    case 'command': {
      const raw = (args.text ?? '').trim();
      if (!raw) throw new Error('action=command necesita text: la orden en castellano.');
      const route = deps.routeOrder ? await deps.routeOrder(raw) : undefined;
      if (route?.ask) {
        return { content: [{ type: 'text' as const, text: route.ask }], details: { asked: true } };
      }
      const text = route?.text ?? raw;
      const intent = parseTvCommand(text);
      if (!intent && tvOrderHasTime(text)) {
        throw new Error(
          `"${text.slice(0, 80)}" lleva hora, plazo o condicion: action=command solo ejecuta ordenes para AHORA y no ha tocado la tele. No la ejecutes ya con otra accion: programala para su momento (p. ej. con la tool reminder) o preguntale a Nico.`,
        );
      }
      if (!intent) {
        throw new Error(
          `No he entendido "${text.slice(0, 80)}" como orden para la tele. Ejemplos: "apaga la tele", "abre Netflix", "volumen a 20", "canal 5", "sube el volumen", "silencio", "pausa", "pon el HDMI 2". Tambien puedes usar las acciones explicitas.`,
        );
      }
      if (route?.intentRunner) {
        const runner = route.intentRunner;
        const said = await enqueueTvMutation(() => runner(intent));
        return {
          content: [
            {
              type: 'text' as const,
              text: `Entendido: ${describeTvIntent(intent)}${route.label ? ` (tele: ${route.label})` : ''}.`,
            },
            { type: 'text' as const, text: said },
          ],
          details: { intent, verified: false },
        };
      }
      const res = route
        ? await route.run(() => runTvAction(deps, intent as TvArgs))
        : await runTvAction(deps, intent as TvArgs);
      return {
        ...res,
        content: [
          {
            type: 'text' as const,
            text: `Entendido: ${describeTvIntent(intent)}${route?.label ? ` (tele: ${route.label})` : ''}.`,
          },
          ...res.content,
        ],
        details: { ...res.details, intent },
      };
    }
    case 'key': {
      // Ráfaga (names): UNA conexión para toda la secuencia. Navegar un menú
      // tecla a tecla abría dos conexiones por pulsación y un turno de modelo
      // entre cada una: por eso Nico la notaba «muy lenta» (2-nov-2026).
      if (Array.isArray(args.names) && args.names.length > 0) {
        if (args.names.length > 40) {
          throw new Error('action=key con names admite hasta 40 teclas seguidas.');
        }
        const batch = args.names.map((n) => String(n).trim().toUpperCase());
        for (const n of batch) {
          if (!KEYS.includes(n as (typeof KEYS)[number])) {
            throw new Error(`action=key necesita nombres validos: ${KEYS.join(', ')}.`);
          }
        }
        const ssapNames = batch.map((n) => KEY_ALIASES[n] ?? n);
        // Navegar a ciegas fue el fallo con Movistar Plus+ (2-nov-2026): la
        // ráfaga devuelve la captura por defecto para verificar el foco.
        const look = args.look ?? true;
        const frames: TvFrame[] = [];
        await enqueueTvMutation(async () => {
          if (deps.keys) {
            await deps.keys(ssapNames);
          } else {
            // Sin ráfaga en el driver: la misma secuencia, tecla a tecla.
            for (const n of ssapNames) {
              await deps.key(n);
            }
          }
          if (look) {
            const shot = await captureFrame(deps).catch(() => null);
            if (shot) frames.push(shot);
          }
        });
        const frame = frames[0] as TvFrame | undefined;
        const content: Array<
          { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
        > = [
          {
            type: 'text' as const,
            text: `He enviado ${ssapNames.length} teclas seguidas (${batch.join(', ')}) por una sola conexión.`,
          },
        ];
        if (look) {
          if (frame) {
            content.push({ type: 'text' as const, text: frameSummary(frame) }, frame.imageBlock);
          } else {
            content.push({
              type: 'text' as const,
              text: 'No pude capturar la tele tras la ráfaga; usa action=screenshot para mirarla.',
            });
          }
        }
        return {
          content,
          details: { names: batch, ...(frame ? { ...frame.state, blank: frame.blank } : {}) },
        };
      }
      const name = (args.name ?? '').trim().toUpperCase();
      if (!KEYS.includes(name as (typeof KEYS)[number])) {
        throw new Error(`action=key necesita un nombre valido: ${KEYS.join(', ')}.`);
      }
      // La whitelist real (lgtv.ts) usa VOLUMEUP/VOLUMEDOWN: los alias
      // publicos se traducen AQUI, en un solo sitio.
      const ssapName = KEY_ALIASES[name] ?? name;
      const look = args.look ?? false;
      const frames: TvFrame[] = [];
      await enqueueTvMutation(async () => {
        await deps.key(ssapName);
        if (look) {
          const shot = await captureFrame(deps).catch(() => null);
          if (shot) frames.push(shot);
        }
      });
      const frame = frames[0] as TvFrame | undefined;
      const content: Array<
        { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
      > = [
        {
          type: 'text' as const,
          text: `He enviado la tecla ${name} (sin confirmación de la tele).`,
        },
      ];
      if (look) {
        if (frame) {
          content.push({ type: 'text' as const, text: frameSummary(frame) }, frame.imageBlock);
        } else {
          content.push({
            type: 'text' as const,
            text: 'No pude capturar la tele tras la tecla; usa action=screenshot para mirarla.',
          });
        }
      }
      return {
        content,
        details: { name, ...(frame ? { ...frame.state, blank: frame.blank } : {}) },
      };
    }
    case 'type': {
      // El texto entero en el campo enfocado (SSAP IME), no letra a letra:
      // es la diferencia entre buscar «ceuta sporting» en un suspiro o en un
      // minuto de pulsaciones. Si la tele no tiene campo activo, error claro.
      const text = (args.text ?? '').trim();
      if (!text) throw new Error('action=type necesita text: lo que se escribe en la tele.');
      if (!deps.typeText) {
        throw new Error(
          'Esta instalación no sabe escribir texto en la tele todavía: usa action=key con names para teclear.',
        );
      }
      const look = args.look ?? true;
      const frames: TvFrame[] = [];
      try {
        await enqueueTvMutation(async () => {
          await deps.typeText?.(text);
          if (look) {
            const shot = await captureFrame(deps).catch(() => null);
            if (shot) frames.push(shot);
          }
        });
      } catch (err) {
        throw new Error(
          `No se pudo escribir en la tele. Si el buscador no esta enfocado, abrelo con action=key ` +
            `y reintenta UNA vez. Si la app tiene teclado propio (YouTube), puede no aceptar texto: ` +
            `no insistas, usa action=search o launch con contentId. ` +
            `Detalle: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const frame = frames[0] as TvFrame | undefined;
      const content: Array<
        { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
      > = [{ type: 'text' as const, text: `He escrito «${text}» en el campo de la tele.` }];
      if (look) {
        if (frame) {
          content.push({ type: 'text' as const, text: frameSummary(frame) }, frame.imageBlock);
        } else {
          content.push({
            type: 'text' as const,
            text: 'No pude capturar la tele tras escribir; usa action=screenshot para mirarla.',
          });
        }
      }
      return {
        content,
        details: {
          typed: true,
          chars: text.length,
          ...(frame ? { ...frame.state, blank: frame.blank } : {}),
        },
      };
    }
    case 'toast': {
      const message = (args.message ?? '').trim();
      if (!message) throw new Error('action=toast necesita message.');
      await enqueueTvMutation(() => deps.toast(message));
      return {
        content: [{ type: 'text' as const, text: 'Aviso mostrado en la tele.' }],
        details: { message },
      };
    }
    case 'power': {
      // Sin `on` explicito NO hay efecto: el schema lo deja opcional y un
      // default silencioso aqui apagaria la tele sin decision del usuario.
      if (typeof args.on !== 'boolean') {
        throw new Error(
          'action=power necesita on: true (encender pantalla) o false (apagar la tele).',
        );
      }
      const on = args.on;
      const outcome = await enqueueTvMutation(() => deps.power(on));
      if (on && outcome?.alreadyOn) {
        return {
          content: [{ type: 'text' as const, text: 'La tele ya estaba encendida.' }],
          details: { on, verified: true, alreadyOn: true },
        };
      }
      if (outcome && outcome.via === 'wol') {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                outcome.verified === true
                  ? 'La tele estaba apagada del todo: la he encendido por red (Wake-on-LAN) y ya responde.'
                  : outcome.verified === false
                    ? 'La tele estaba apagada del todo: he enviado el encendido por red (Wake-on-LAN), pero aun no responde. ' +
                      'Puede tardar unos segundos mas; si no enciende, revisa que "Encender con Wi-Fi" este activado en la tele.'
                    : 'La tele estaba apagada del todo: he enviado el encendido por red (Wake-on-LAN), sin confirmar.',
            },
          ],
          details: { on, verified: outcome.verified === true, via: 'wol' },
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: on
              ? 'Orden de encender la pantalla enviada. No confirma el estado fisico: si la tele estaba apagada del todo (sin SSAP), la orden no llega.'
              : 'Orden de apagar la tele enviada. No confirma el estado fisico.',
          },
        ],
        details: { on, verified: false },
      };
    }
    case 'volume': {
      const level = args.level;
      if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 100) {
        throw new Error('action=volume necesita level: entero 0-100 (nivel absoluto).');
      }
      await enqueueTvMutation(() => needGh(deps)('volume', level));
      return {
        content: [{ type: 'text' as const, text: `Volumen puesto a ${level} (orden enviada).` }],
        details: { level, verified: false },
      };
    }
    case 'mute': {
      if (typeof args.on !== 'boolean') {
        throw new Error('action=mute necesita on: true (silencia) o false (vuelve el sonido).');
      }
      const on = args.on;
      await enqueueTvMutation(() => needGh(deps)('mute', on));
      return {
        content: [
          {
            type: 'text' as const,
            text: on ? 'Tele silenciada (orden enviada).' : 'Sonido de vuelta (orden enviada).',
          },
        ],
        details: { on, verified: false },
      };
    }
    case 'input': {
      const input = (args.input ?? '').trim().toLowerCase();
      if (!TV_INPUTS.includes(input as (typeof TV_INPUTS)[number])) {
        throw new Error(`action=input necesita un valor valido: ${TV_INPUTS.join(', ')}.`);
      }
      await enqueueTvMutation(() => needGh(deps)('input', input));
      return {
        content: [{ type: 'text' as const, text: `Entrada cambiada a ${input} (orden enviada).` }],
        details: { input, verified: false },
      };
    }
    case 'url': {
      const url = (args.url ?? '').trim();
      // Misma regla que Glasshouse: solo http(s); un file: o javascript:
      // iria tal cual al navegador de la tele.
      if (!/^https?:\/\/[^\s]+$/i.test(url)) {
        throw new Error('action=url necesita una URL http:// o https:// .');
      }
      await enqueueTvMutation(() => needGh(deps)('launchUrl', url));
      return {
        content: [
          {
            type: 'text' as const,
            text: `He abierto ${url} en el navegador de la tele (orden enviada).`,
          },
        ],
        details: { url, verified: false },
      };
    }
    case 'picture': {
      const pictureMode = (args.pictureMode ?? '').trim();
      if (!/^[A-Za-z0-9]{2,40}$/.test(pictureMode)) {
        throw new Error('action=picture necesita pictureMode (standard, eco, cinema, vivid...).');
      }
      await enqueueTvMutation(() => needGh(deps)('pictureMode', pictureMode));
      return {
        content: [
          {
            type: 'text' as const,
            text: `Imagen de la tele en modo ${pictureMode} (orden enviada).`,
          },
        ],
        details: { pictureMode, verified: false },
      };
    }
    case 'closeApp': {
      const appId = (args.appId ?? '').trim();
      if (!appId) throw new Error('action=closeApp necesita appId (miralos con action=apps).');
      await enqueueTvMutation(() => needGh(deps)('closeApp', appId));
      return {
        content: [
          { type: 'text' as const, text: `He cerrado ${appId} en la tele (orden enviada).` },
        ],
        details: { appId, verified: false },
      };
    }
    case 'screen': {
      // screenOff deja el panel negro con el audio sonando (no es apagar).
      if (typeof args.on !== 'boolean') {
        throw new Error(
          'action=screen necesita on: true (enciende el panel) o false (panel negro, el audio sigue).',
        );
      }
      const on = args.on;
      await enqueueTvMutation(() => needGh(deps)(on ? 'screenOn' : 'screenOff'));
      return {
        content: [
          {
            type: 'text' as const,
            text: on
              ? 'Panel encendido (orden enviada).'
              : 'Panel en negro, el audio sigue (orden enviada).',
          },
        ],
        details: { on, verified: false },
      };
    }
    case 'media': {
      const command = (args.command ?? '').trim();
      if (!MEDIA_COMMANDS.includes(command as (typeof MEDIA_COMMANDS)[number])) {
        throw new Error(`action=media necesita command: ${MEDIA_COMMANDS.join(', ')}.`);
      }
      await enqueueTvMutation(() => needGh(deps)('media', command));
      return {
        content: [{ type: 'text' as const, text: `Orden de reproduccion ${command} enviada.` }],
        details: { command, verified: false },
      };
    }
    case 'adblock': {
      const mode = (args.mode ?? '').trim().toLowerCase();
      if (!ADBLOCK_MODES.includes(mode as (typeof ADBLOCK_MODES)[number])) {
        throw new Error(`action=adblock necesita mode: ${ADBLOCK_MODES.join(', ')}.`);
      }
      await enqueueTvMutation(() => needGh(deps)('setAdBlock', mode));
      return {
        content: [
          {
            type: 'text' as const,
            text: `Bloqueo de anuncios de la tele en modo ${mode} (orden enviada).`,
          },
        ],
        details: { mode, verified: false },
      };
    }
    case 'adTracking': {
      if (typeof args.on !== 'boolean') {
        throw new Error(
          'action=adTracking necesita on: true (limita el seguimiento publicitario) o false.',
        );
      }
      const on = args.on;
      await enqueueTvMutation(() => needGh(deps)('limitAdTracking', on));
      return {
        content: [
          {
            type: 'text' as const,
            text: on
              ? 'Seguimiento publicitario limitado (orden enviada).'
              : 'Limite de seguimiento publicitario quitado (orden enviada).',
          },
        ],
        details: { on, verified: false },
      };
    }
    default:
      throw new Error(`accion desconocida: ${String(args.action)}`);
  }
}

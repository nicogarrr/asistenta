import type { AgentTool } from '@earendil-works/pi-agent-core';
import { type Static, Type } from 'typebox';
import { log } from '../log.js';
import { inspectTv } from '../tv/inspection.js';
import type { TvPowerOutcome } from '../tv/power.js';
import { describeTvStatus, type TvStatus } from '../tv/status.js';

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
const SUSPECT_BLANK_BYTES = 24_000;

export interface TvMemoryState {
  /** appId en primer plano en el momento de mirar. */
  appId: string;
  category: string[];
  /** ISO. */
  at: string;
  framePath: string;
  bytes: number;
}

export interface TvToolDeps {
  /** Frame actual de la tele. Lanza si no esta emparejada o apagada. */
  /** ext opcional: los mocks pueden omitirla (cae a jpg); el adapter real la deriva de la firma. */
  shot: () => Promise<{ image: Buffer; mimeType: string; ext?: string }>;
  foreground: () => Promise<{ appId: string; category: string[] }>;
  apps: () => Promise<Array<{ id: string; title: string }>>;
  /**
   * Estado en vivo sin captura (src/tv/status.ts): energia, app/entrada y
   * volumen. Ausente = instalacion antigua: action=status lo dice.
   */
  status?: () => Promise<TvStatus>;
  /** Glasshouse GET /api/stats, optional for older installations. */
  stats?: () => Promise<unknown>;
  launch: (id: string) => Promise<void>;
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

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('screenshot'),
    Type.Literal('state'),
    Type.Literal('status'),
    Type.Literal('apps'),
    Type.Literal('inspect'),
    Type.Literal('launch'),
    Type.Literal('key'),
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
  ]),
  appId: Type.Optional(
    Type.String({ description: 'Para launch: el id de la app (sacalo de action=apps).' }),
  ),
  name: Type.Optional(
    Type.String({
      description: 'Para key: HOME, BACK, ENTER, LEFT, RIGHT, UP, DOWN, VOLUP, VOLDOWN.',
    }),
  ),
  message: Type.Optional(Type.String({ description: 'Para toast: el texto a mostrar.' })),
  on: Type.Optional(
    Type.Boolean({
      description:
        'Para power/screen/mute/adTracking: true enciende/activa, false apaga/desactiva.',
    }),
  ),
  level: Type.Optional(Type.Number({ description: 'Para volume: nivel absoluto, entero 0-100.' })),
  input: Type.Optional(
    Type.String({ description: 'Para input: hdmi1, hdmi2, hdmi3, hdmi4 o tv.' }),
  ),
  url: Type.Optional(
    Type.String({ description: 'Para url: pagina http(s) a abrir en el navegador de la tele.' }),
  ),
  command: Type.Optional(
    Type.String({ description: 'Para media: play, pause, playPause, stop, rewind o fastForward.' }),
  ),
  mode: Type.Optional(
    Type.String({
      description:
        'Para adblock: off (nada), ads (publi y telemetria) o full (tambien tienda/updates LG).',
    }),
  ),
});

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

function enqueueTvMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = tvMutationQueue.then(fn, fn);
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

export function createTvTool(deps: TvToolDeps): AgentTool<typeof Params> {
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
      'action=launch arranca una app, action=key pulsa el mando, action=toast muestra un aviso,',
      'action=power apaga o enciende.',
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
    parameters: Params,
    // Sequential: two captures in one batch can straddle a repaint and report a
    // screen state that no longer exists, same reason as the ocr tool.
    executionMode: 'sequential',
    execute: async (_id, args) => {
      try {
        return await runTvAction(deps, args);
      } catch (err) {
        throw explainTvError(err);
      }
    },
  };
}

type TvArgs = Static<typeof Params>;

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

async function runTvAction(deps: TvToolDeps, args: TvArgs) {
  switch (args.action) {
    case 'screenshot': {
      // La captura entera va por la MISMA cola que las mutaciones: dos
      // agentes nunca intercalan key/shot (auditor: key-start,shot,key-end).
      return enqueueTvMutation(async () => {
        const { image, mimeType, ext = 'jpg' } = await deps.shot();
        // La app se lee DESPUES del disparo (ventana menor), pero ni asi es
        // pareja atomica con el frame: otra accion puede cambiarla entre ambas.
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
        log.info('tv screenshot', { appId: state.appId, bytes: state.bytes });
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
          content: [
            { type: 'text' as const, text: lines.join(' ') },
            { type: 'image' as const, mimeType, data: image.toString('base64') },
          ],
          details: { ...state, blank },
        };
      });
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
      const appId = (args.appId ?? '').trim();
      if (!appId) throw new Error('action=launch necesita appId (miralos con action=apps).');
      await enqueueTvMutation(() => deps.launch(appId));
      return {
        content: [{ type: 'text' as const, text: `He lanzado ${appId} en la tele.` }],
        details: { appId, verified: false },
      };
    }
    case 'key': {
      const name = (args.name ?? '').trim().toUpperCase();
      if (!KEYS.includes(name as (typeof KEYS)[number])) {
        throw new Error(`action=key necesita un nombre valido: ${KEYS.join(', ')}.`);
      }
      // La whitelist real (lgtv.ts) usa VOLUMEUP/VOLUMEDOWN: los alias
      // publicos se traducen AQUI, en un solo sitio.
      const ssapName = KEY_ALIASES[name] ?? name;
      await enqueueTvMutation(() => deps.key(ssapName));
      return {
        content: [
          {
            type: 'text' as const,
            text: `He enviado la tecla ${name} (sin confirmacion de la tele).`,
          },
        ],
        details: { name },
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

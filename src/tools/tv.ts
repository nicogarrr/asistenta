import { log } from '../log.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

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
  shot: () => Promise<{ image: Buffer; mimeType: string }>;
  foreground: () => Promise<{ appId: string; category: string[] }>;
  apps: () => Promise<Array<{ id: string; title: string }>>;
  launch: (id: string) => Promise<void>;
  key: (name: string) => Promise<void>;
  toast: (message: string) => Promise<void>;
  power: (on: boolean) => Promise<void>;
  /** Guarda el frame en disco y devuelve la ruta (queda como ultimo estado). */
  saveFrame: (bytes: Buffer) => string;
  getState: () => TvMemoryState | null;
  setState: (state: TvMemoryState) => void;
}

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('screenshot'),
    Type.Literal('state'),
    Type.Literal('apps'),
    Type.Literal('launch'),
    Type.Literal('key'),
    Type.Literal('toast'),
    Type.Literal('power'),
  ]),
  appId: Type.Optional(
    Type.String({ description: 'Para launch: el id de la app (sacalo de action=apps).' }),
  ),
  name: Type.Optional(
    Type.String({ description: 'Para key: HOME, BACK, ENTER, LEFT, RIGHT, UP, DOWN, VOLUP, VOLDOWN.' }),
  ),
  message: Type.Optional(Type.String({ description: 'Para toast: el texto a mostrar.' })),
  on: Type.Optional(Type.Boolean({ description: 'Para power: true enciende, false apaga.' })),
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
      'action=apps lista los ids y titulos instalados (los nuestras tienen id tipo org.webosbrew.hbchannel).',
      'action=launch arranca una app, action=key pulsa el mando, action=toast muestra un aviso,',
      'action=power apaga o enciende.',
      '',
      'LIMITE IMPORTANTE: el contenido con DRM (Netflix, Prime, Disney+, DAZN, Max) sale en NEGRO.',
      'No es un fallo ni es que la tele este apagada: LG bloquea la captura de video protegido en TVs',
      'de 2020 en adelante. Si el frame es negro, no digas que la tele esta encendida ni apagada:',
      'solo que hay contenido protegido y no se puede ver. Para comprobar eso, usa action=state o',
      'action=apps, que si funcionan con la tele reproduciendo.',
    ].join(' '),
    parameters: Params,
    // Sequential: two captures in one batch can straddle a repaint and report a
    // screen state that no longer exists, same reason as the ocr tool.
    executionMode: 'sequential',
    execute: async (_id, args) => {
      switch (args.action) {
        case 'screenshot': {
          const fg = await deps.foreground().catch(() => null);
          const { image, mimeType } = await deps.shot();
          const path = deps.saveFrame(image);
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
            fg ? `App en primer plano: ${fg.appId}${fg.category.length ? ` (${fg.category.join(', ')})` : ''}.` : 'No he podido leer la app en primer plano.',
            `Guardado en ${path}.`,
          ];
          if (blank) {
            lines.push(
              'AVISO: el frame es casi vacio. Lo mas probable es contenido con DRM (streaming), ' +
                'no un fallo de la tele. No deduzcas el estado de la tele de esto: confirma con ' +
                'action=state antes de afirmar nada.',
            );
          }
          return {
            content: [
              { type: 'text' as const, text: lines.join(' ') },
              { type: 'image' as const, mimeType, data: image.toString('base64') },
            ],
            details: { ...state, blank },
          };
        }
        case 'state': {
          const state = deps.getState();
          if (!state) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text:
                    'Nunca he mirado la tele en esta sesion. Usa action=screenshot para mirarla de verdad.',
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
          await deps.launch(appId);
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
          await deps.key(name);
          return {
            content: [{ type: 'text' as const, text: `He enviado la tecla ${name}.` }],
            details: { name },
          };
        }
        case 'toast': {
          const message = (args.message ?? '').trim();
          if (!message) throw new Error('action=toast necesita message.');
          await deps.toast(message);
          return {
            content: [{ type: 'text' as const, text: 'Aviso mostrado en la tele.' }],
            details: { message },
          };
        }
        case 'power': {
          const on = args.on === true;
          await deps.power(on);
          return {
            content: [
              { type: 'text' as const, text: on ? 'Tele encendida.' : 'Tele apagada.' },
            ],
            details: { on },
          };
        }
        default:
          throw new Error(`accion desconocida: ${String(args.action)}`);
      }
    },
  };
}
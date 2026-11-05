import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import {
  SPOTIFY_KEYS,
  SPOTIFY_NO_CLIENT,
  type SpotifyAction,
  type SpotifyDeps,
  SpotifyError,
  spotifyClientId,
  spotifyDo,
  startSpotifyLogin,
} from '../spotify.js';

/**
 * Herramienta `spotify`: «pon X», pausa, siguiente, qué suena, volumen y en qué
 * dispositivo. Usa la API oficial (src/spotify.ts); sin configurar, lo dice y no hace nada.
 */
const Params = lazySchema(() =>
  Type.Object({
    action: Type.Union(
      [
        'estado',
        'play',
        'pausa',
        'siguiente',
        'anterior',
        'pon',
        'volumen',
        'dispositivos',
        'usar_dispositivo',
      ].map((a) => Type.Literal(a)),
      {
        description:
          'estado = qué suena; pon = buscar y poner; usar_dispositivo = pasar la música a otro.',
      },
    ),
    query: Type.Optional(Type.String({ description: 'Para pon: lo que hay que buscar.' })),
    tipo: Type.Optional(
      Type.Union(
        ['cancion', 'artista', 'album', 'playlist'].map((t) => Type.Literal(t)),
        {
          description: 'Para pon (por defecto cancion).',
        },
      ),
    ),
    dispositivo: Type.Optional(
      Type.String({ description: '«PC», «móvil», «tele» o el nombre del dispositivo.' }),
    ),
    volumen: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  }),
);

export function createSpotifyTool(deps: {
  spotify: () => SpotifyDeps;
  allowed: () => boolean;
}): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'spotify',
    label: 'Spotify',
    description:
      'Controla Spotify del dueño por su API: «pon X» (canción, artista, álbum o playlist), pausa, sigue, siguiente, anterior, qué suena, volumen, sus dispositivos y pasar la música al PC, móvil o tele. Úsala antes que manejar la app con el ratón.',
    parameters: Params(),
    execute: async (_id, args) => {
      const text = deps.allowed()
        ? await spotifyDo(deps.spotify(), {
            action: args.action as SpotifyAction,
            query: args.query,
            tipo: args.tipo as 'cancion' | 'artista' | 'album' | 'playlist' | undefined,
            dispositivo: args.dispositivo,
            volumen: args.volumen,
          })
        : 'Spotify solo se maneja desde el chat privado del dueño.';
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}

/**
 * `/spotify [conectar|desconectar|pausa|siguiente|…]`. `conectar` abre el permiso en el
 * navegador del PC (la vuelta es a 127.0.0.1 del PC) y avisa por `notify` al terminar.
 */
export async function spotifyCommand(
  args: string,
  deps: SpotifyDeps & {
    openBrowser: (url: string) => Promise<boolean>;
    notify: (text: string) => void;
  },
): Promise<{ text: string; buttons?: Array<{ label: string; action: string }> }> {
  const sub = args.trim().toLowerCase();
  if (!spotifyClientId(deps.env)) return { text: SPOTIFY_NO_CLIENT };
  if (sub === 'conectar') {
    try {
      const flow = await startSpotifyLogin(deps);
      flow.done.then(
        () => deps.notify('✅ Spotify conectado. Prueba: «pon Bad Bunny» o /spotify.'),
        (err: Error) => deps.notify(`❌ ${err.message}`),
      );
      const opened = await deps.openBrowser(flow.url);
      return {
        text: opened
          ? '🎵 Te he abierto el permiso de Spotify en el navegador del PC: pulsa «Aceptar». (Tiene que ser en el PC; caduca en 5 min.)'
          : '🎵 Abre este enlace en el navegador del PC y pulsa «Aceptar» (caduca en 5 min):',
        buttons: opened
          ? undefined
          : [{ label: '🎵 Dar permiso a Spotify', action: `url:${flow.url}` }],
      };
    } catch (err) {
      return {
        text:
          err instanceof SpotifyError
            ? err.message
            : 'No he podido empezar la conexión con Spotify.',
      };
    }
  }
  if (sub === 'desconectar') {
    await deps.vault.delete(SPOTIFY_KEYS.refreshToken);
    return {
      text: 'Hecho: he olvidado el permiso de Spotify. Puedes quitarlo también en spotify.com/account/apps.',
    };
  }
  const map: Record<string, SpotifyAction> = {
    '': 'estado',
    estado: 'estado',
    pausa: 'pausa',
    play: 'play',
    siguiente: 'siguiente',
    anterior: 'anterior',
    dispositivos: 'dispositivos',
  };
  const action = map[sub];
  if (!action)
    return {
      text: 'Con /spotify: conectar, desconectar, pausa, play, siguiente, anterior, dispositivos. O dime «pon …».',
    };
  return { text: await spotifyDo(deps, { action }) };
}

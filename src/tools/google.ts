import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { type GoogleDeps, GoogleNotConnectedError, startLoopbackFlow } from '../google/oauth.js';
import {
  borrarEvento,
  buscarContacto,
  buscarDrive,
  buscarEventos,
  crearEvento,
  leerDrive,
  moverEvento,
  type WorkspaceDeps,
} from '../google/workspace.js';

/**
 * Herramienta `google`: apunta, mueve y borra eventos de su Google Calendar (cada cambio
 * pasa por la aprobación del chat), busca un contacto y busca o lee archivos de su Drive.
 * Sin conexión o sin el permiso nuevo, contesta con el paso exacto («/google conectar»).
 */
const ACTIONS = [
  'evento_crear',
  'evento_mover',
  'evento_borrar',
  'eventos_buscar',
  'contacto',
  'drive_buscar',
  'drive_leer',
] as const;

const Params = lazySchema(() =>
  Type.Object({
    action: Type.Union(
      ACTIONS.map((a) => Type.Literal(a)),
      {
        description:
          'evento_*: Google Calendar (mover/borrar necesitan id: búscalo antes con eventos_buscar); contacto: teléfono/correo de alguien; drive_buscar y drive_leer: sus archivos de Drive.',
      },
    ),
    titulo: Type.Optional(Type.String()),
    inicio: Type.Optional(
      Type.String({
        description: 'Hora local «2026-11-12T10:00», o «2026-11-12» para todo el día.',
      }),
    ),
    fin: Type.Optional(Type.String({ description: 'Como inicio; por defecto, una hora después.' })),
    lugar: Type.Optional(Type.String()),
    descripcion: Type.Optional(Type.String()),
    id: Type.Optional(Type.String({ description: 'id del evento o del archivo de Drive.' })),
    texto: Type.Optional(Type.String({ description: 'Qué buscar (evento, contacto o archivo).' })),
    desde: Type.Optional(Type.String({ description: 'eventos_buscar: desde (ISO).' })),
    hasta: Type.Optional(Type.String({ description: 'eventos_buscar: hasta (ISO).' })),
  }),
);

export function createGoogleTool(deps: {
  google: () => WorkspaceDeps;
  allowed: () => boolean;
}): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'google',
    label: 'Google',
    description:
      'Google del dueño: apuntar, mover o borrar eventos de su Google Calendar (lo ve en el móvil), buscar eventos, buscar un contacto (teléfono, correo) y buscar o leer archivos de su Google Drive.',
    parameters: Params(),
    execute: async (_id, a) => {
      let text: string;
      if (!deps.allowed()) text = 'Google solo se usa en el chat privado del dueño.';
      else {
        const g = deps.google();
        switch (a.action) {
          case 'evento_crear':
            text = await crearEvento(g, a);
            break;
          case 'evento_mover':
            text = await moverEvento(g, a);
            break;
          case 'evento_borrar':
            text = await borrarEvento(g, a);
            break;
          case 'eventos_buscar':
            text = await buscarEventos(g, a);
            break;
          case 'contacto':
            text = await buscarContacto(g, a.texto ?? '');
            break;
          case 'drive_buscar':
            text = await buscarDrive(g, a.texto ?? '');
            break;
          case 'drive_leer':
            text = await leerDrive(g, a.id ?? '');
            break;
          default:
            text = 'No sé hacer eso con Google.';
        }
      }
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}

/**
 * `/google conectar`: abre el permiso de Google (calendario, contactos, Drive) en el
 * navegador del PC con un clic y avisa al terminar. Reutiliza el cliente ya guardado.
 */
export async function googleChatCommand(
  args: string,
  deps: GoogleDeps & {
    openBrowser: (url: string) => Promise<boolean>;
    notify: (text: string) => void;
  },
): Promise<{ text: string; buttons?: Array<{ label: string; action: string }> }> {
  const sub = args.trim().toLowerCase();
  if (sub !== 'conectar') {
    const { GoogleAuth, tienePermiso, PERMISO_TEXTO } = await import('../google/oauth.js');
    const auth = new GoogleAuth(deps);
    if (!(await auth.connected()))
      return {
        text: 'Google no está conectado. Escribe /google conectar estando en el PC (pasos en docs/SETUP-INTEGRACIONES.md).',
      };
    const granted = await auth.scopes();
    const lines = (['calendar', 'calendarWrite', 'contacts', 'drive'] as const).map(
      (p) => `${tienePermiso(granted, p) ? '✅' : '❌'} ${PERMISO_TEXTO[p]}`,
    );
    const falta = lines.some((l) => l.startsWith('❌'));
    return {
      text: `Google conectado:\n${lines.join('\n')}${falta ? '\nPara lo que falta: /google conectar (en el PC) y acepta todas las casillas.' : ''}`,
    };
  }
  try {
    const flow = await startLoopbackFlow(deps);
    flow.done.then(
      ({ scopes }) =>
        deps.notify(
          scopes.some((s) => s.endsWith('/calendar.events'))
            ? '✅ Google conectado: ya puedo apuntar en tu Google Calendar, buscar contactos y leer tu Drive. Prueba «apunta dentista el jueves a las 10».'
            : '⚠️ Google se ha conectado pero sin todas las casillas. Repite /google conectar y márcalas todas.',
        ),
      (err: Error) => deps.notify(`❌ ${err.message}`),
    );
    const opened = await deps.openBrowser(flow.url);
    return {
      text: opened
        ? '🔑 Te he abierto el permiso de Google en el navegador del PC: elige tu cuenta y marca todas las casillas. (Tiene que ser en el PC; caduca en 5 min.)'
        : '🔑 Abre este enlace en el navegador del PC y marca todas las casillas (caduca en 5 min):',
      buttons: opened
        ? undefined
        : [{ label: '🔑 Dar permiso a Google', action: `url:${flow.url}` }],
    };
  } catch (err) {
    if (err instanceof GoogleNotConnectedError)
      return {
        text: 'Aún no hay cliente de Google en este PC. Sigue el apartado Google de docs/SETUP-INTEGRACIONES.md (crear el cliente, 10 min) y luego /google conectar.',
      };
    return {
      text:
        err instanceof Error && err.message
          ? err.message
          : 'No he podido empezar la conexión con Google.',
    };
  }
}

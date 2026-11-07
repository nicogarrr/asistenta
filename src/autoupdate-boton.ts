/**
 * Botón «🔄 Buscar actualización ahora» de Telegram: fuerza la misma revisión que
 * `pa autoupdate now` sin esperar a la automática y sin orden nueva (siguen 60).
 *
 * El daemon no se actualiza a sí mismo (la actualización lo para y lo vuelve a arrancar):
 * lanza `pa autoupdate boton` aparte y ese proceso contesta en el chat del dueño («ya
 * estás al día», «hay versión nueva, me actualizo» y luego el aviso de siempre, o el
 * error). Aquí solo se decide si se lanza: dueño en privado, Windows, autoactualización
 * encendida y una sola búsqueda a la vez (doble toque o la del vigilante).
 */
import { autoupdateEnvEnabled, lockHeld, readAutoupdateState } from './autoupdate.js';

export const UPDATE_CALLBACK_PREFIX = 'upd:';
export const UPDATE_CALLBACK = `${UPDATE_CALLBACK_PREFIX}buscar`;
export const UPDATE_BUTTON_LABEL = '🔄 Buscar actualización ahora';
export const UPDATE_SEARCHING = 'Buscando actualización…';
export const UPDATE_ALREADY_RUNNING =
  'Ya estoy buscando una actualización: te aviso aquí cuando acabe.';
export const UPDATE_OWNER_ONLY = 'Este botón solo funciona en el chat privado del dueño.';
export const UPDATE_STALE = 'Este botón ya no sirve. Escribe /actualizacion para ver cómo va.';
export const UPDATE_OFF_NOTICE = 'La autoactualización está apagada.';
export const UPDATE_OFF_ENV =
  'La autoactualización está apagada (PA_AUTOUPDATE=0 en tu .env), así que no busco versiones nuevas. Para encenderla, quita esa línea del .env (o pon PA_AUTOUPDATE=1) y reinicia Asistenta.';
export const UPDATE_OFF_STATE =
  'La autoactualización está apagada (pa autoupdate off), así que no busco versiones nuevas. Para encenderla: pa autoupdate on.';
export const UPDATE_NOT_WINDOWS =
  'La autoactualización solo funciona en Windows. Aquí actualízala a mano en la carpeta de Asistenta: git pull, npm ci y npm run build, y luego pa restart.';
export const UPDATE_LAUNCH_FAILED =
  'No he podido lanzar la búsqueda de actualización. En el PC, en la carpeta de Asistenta: pa autoupdate now.';
/** Ninguna búsqueda dura tanto: pasado esto, una que no avisó de su final ya no cuenta. */
export const UPDATE_LATER_CALLBACK = `${UPDATE_CALLBACK_PREFIX}luego`;
export const UPDATE_LATER_NOTICE = 'Vale, luego. Te lo vuelvo a ofrecer mañana.';

/** «Actualizar» / «Luego»: la oferta diaria del modo PA_AUTOUPDATE_MODO=preguntar. */
export function offerButtons(): UpdateButton[] {
  return [
    { label: '✅ Actualizar', action: UPDATE_CALLBACK },
    { label: '⏰ Luego', action: UPDATE_LATER_CALLBACK },
  ];
}

export const UPDATE_RUN_MAX_MS = 45 * 60_000;

export type UpdateButton = { label: string; action: string };

/** El botón, para ponerlo debajo de un mensaje (Outbound.buttons o sendOwnerTelegram). */
export function updateButtons(): UpdateButton[] {
  return [{ label: UPDATE_BUTTON_LABEL, action: UPDATE_CALLBACK }];
}

/** Por qué no se busca: apagada por .env o por `pa autoupdate off`; null si está encendida. */
export function updateOffText(stateDir: string, env: NodeJS.ProcessEnv): string | null {
  if (!autoupdateEnvEnabled(env)) return UPDATE_OFF_ENV;
  if (readAutoupdateState(stateDir).off === true) return UPDATE_OFF_STATE;
  return null;
}

export interface UpdateButtonDeps {
  stateDir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  now(): number;
  /** Lanza `pa autoupdate boton` aparte; `onExit` cuando ese proceso acaba. Lanza si no puede. */
  launch(onExit: () => void): void;
}

/** `notice` va en el aviso del botón (≤200); `reply`, si hay, como mensaje al chat. */
export interface UpdateButtonReply {
  notice: string;
  reply?: string;
}

/** Una por daemon: recuerda la búsqueda en marcha para no lanzar dos. */
export function createUpdateButton(
  deps: UpdateButtonDeps,
): (press: { data: string; isOwner: boolean }) => UpdateButtonReply {
  let runningSince: number | null = null;
  return ({ data, isOwner }) => {
    if (data === UPDATE_LATER_CALLBACK) return { notice: UPDATE_LATER_NOTICE };
    if (data !== UPDATE_CALLBACK) return { notice: UPDATE_STALE };
    if (!isOwner) return { notice: UPDATE_OWNER_ONLY };
    if (deps.platform !== 'win32') return { notice: 'Solo en Windows.', reply: UPDATE_NOT_WINDOWS };
    const off = updateOffText(deps.stateDir, deps.env);
    if (off) return { notice: UPDATE_OFF_NOTICE, reply: off };
    const now = deps.now();
    if (runningSince !== null && now - runningSince < UPDATE_RUN_MAX_MS) {
      return { notice: UPDATE_ALREADY_RUNNING };
    }
    if (lockHeld(deps.stateDir, now)) return { notice: UPDATE_ALREADY_RUNNING };
    const started = now;
    runningSince = started;
    try {
      deps.launch(() => {
        if (runningSince === started) runningSince = null;
      });
    } catch {
      runningSince = null;
      return { notice: 'No he podido buscar.', reply: UPDATE_LAUNCH_FAILED };
    }
    return { notice: UPDATE_SEARCHING };
  };
}

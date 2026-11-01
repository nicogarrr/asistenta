import { DaemonNotRunningError } from './daemon-control.js';

export interface StopCommandDeps {
  stop: () => Promise<{ instanceId: string }>;
  /** Writes the «parado a propósito» mark the Windows watchdog reads. */
  markStopped: () => void;
  write: (text: string) => void;
  writeErr: (text: string) => void;
}

export const NOT_RUNNING_TEXT =
  'Asistenta no estaba en marcha: no había nada que parar.\n' +
  'No la volveré a arrancar sola hasta que reinicies el PC o hagas `pa iniciar`.\n';

export const STOPPED_TEXT =
  'Asistenta parada: ha cerrado bien, sin dejar nada a medias.\n' +
  'No la volveré a arrancar sola hasta que reinicies el PC o hagas `pa iniciar`.\n';

/**
 * The control layer speaks in technical terms («Metadata…», «flock», «Parada … no
 * confirmada…»). The person gets what happened and what to do, also for unknown reasons.
 */
const PLAIN_REASONS: [RegExp, string][] = [
  [
    /ocupado|flock no disponible/i,
    'ahora mismo otra orden la está arrancando o parando. Prueba otra vez en un momento.',
  ],
  [
    /no confirmada|no se confirma/i,
    'le he pedido que se cierre, pero no ha terminado a tiempo. No he cerrado nada a la fuerza: prueba `pa stop` otra vez en un minuto.',
  ],
  [
    /no (fue )?limpio/i,
    'se ha cerrado, pero no he podido comprobar que lo hiciera sin dejar nada a medias.',
  ],
  [
    /Metadata .*(ilegible|inválida|cambió|cambiada)/i,
    'sus ficheros de control están dañados y parece que sigue en marcha. Reinicia el PC o ciérrala desde el Administrador de tareas.',
  ],
  [
    /instancia|sustituida|autenticad|prueba de cierre|propiedad .*perdida/i,
    'ha cambiado mientras la paraba (se ha reiniciado o hay otra en marcha). Mira cómo está con `pa status` y prueba otra vez.',
  ],
  [
    /EACCES|EPERM|permission denied/i,
    'no tengo permiso para leer sus ficheros de control. Prueba desde la misma cuenta con la que se arrancó.',
  ],
];

/** Lo que no está en la lista: una línea clara en vez del texto técnico. */
export const UNKNOWN_STOP_REASON =
  'ha pasado algo inesperado con sus ficheros de control. Mira cómo está con `pa status`; si sigue en marcha y no se para, reinicia el PC.';

/** `pa restart` no reinicia: lo dice claro y explica cómo hacerlo a mano. */
export const RESTART_TEXT =
  'pa restart no reinicia por sí solo, porque no puedo asegurar que Asistenta vuelva a arrancar. Para reiniciarla: pa stop y después levantar.bat (o pa iniciar). No he parado ni arrancado nada.';

export function plainStopReason(reason: string): string {
  if (OTHER_OWNER.test(reason)) return 'sus ficheros de control son de otra cuenta de usuario.';
  return PLAIN_REASONS.find(([re]) => re.test(reason))?.[1] ?? UNKNOWN_STOP_REASON;
}

/** The control files belong to another Windows/Linux account (or an elevated one). */
const OTHER_OWNER = /propietario/i;
const OTHER_OWNER_HINT =
  'Suele pasar si Asistenta se arrancó con otro usuario o como administrador: párala desde esa misma cuenta.\n';

/**
 * `pa stop`. Asistenta not running is the result the person asked for, not an error: it
 * exits 0 and keeps the «parado a propósito» mark, so the watchdog does not bring it back.
 * A real failure says so in Spanish, exits 1 and writes no mark (the watchdog stays as it was).
 */
export async function runStopCommand(deps: StopCommandDeps): Promise<number> {
  try {
    await deps.stop();
  } catch (error) {
    if (error instanceof DaemonNotRunningError) {
      deps.markStopped();
      deps.write(NOT_RUNNING_TEXT);
      return 0;
    }
    const reason = error instanceof Error ? error.message : String(error);
    deps.writeErr(
      `No he podido parar Asistenta: ${plainStopReason(reason)}\n` +
        (OTHER_OWNER.test(reason) ? OTHER_OWNER_HINT : '') +
        'No he marcado nada: el vigilante sigue como estaba.\n',
    );
    return 1;
  }
  deps.markStopped();
  deps.write(STOPPED_TEXT);
  return 0;
}

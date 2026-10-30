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

/**
 * `pa stop`. Asistenta not running is the result the person asked for, not an error: it
 * exits 0 and keeps the «parado a propósito» mark, so the watchdog does not bring it back.
 * A real failure says so in Spanish, exits 1 and writes no mark (the watchdog stays as it was).
 */
export async function runStopCommand(deps: StopCommandDeps): Promise<number> {
  let result: { instanceId: string };
  try {
    result = await deps.stop();
  } catch (error) {
    if (error instanceof DaemonNotRunningError) {
      deps.markStopped();
      deps.write(NOT_RUNNING_TEXT);
      return 0;
    }
    const reason = error instanceof Error ? error.message : String(error);
    deps.writeErr(
      `No he podido parar Asistenta: ${reason}\n` +
        'No he marcado nada: el vigilante sigue como estaba.\n',
    );
    return 1;
  }
  deps.markStopped();
  deps.write(
    `Instancia ${result.instanceId.slice(0, 12)} detenida con cierre limpio confirmado.\n`,
  );
  return 0;
}

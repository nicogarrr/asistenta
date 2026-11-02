/**
 * Órdenes que Windows lanza solas cada poco, sin cargar todo Asistenta.
 *
 * La bandeja pregunta `pa status --json` cada minuto y el vigilante corre
 * `pa autostart vigilar` cada 5 minutos, las 24 horas. Por `cli.ts` cada una cargaba
 * el grafo entero (~900 módulos: herramientas, Telegram, modelo…) para leer un par de
 * ficheros: ~265 ms de CPU y ~95 MB por lanzamiento, 72 veces por hora con el PC en
 * reposo. Aquí se llama a la MISMA función que usa `cli.ts` para esas órdenes
 * (`statusCommand`, `autostartCommand`), con la misma zona horaria aplicada antes, así
 * que la salida es idéntica; el resto de órdenes sigue por `cli.ts`.
 */
import { applyConfiguredTimeZone } from './datecontext.js';

/** Devuelve la ejecución de la orden si es de las ligeras; `null` si va por `cli.ts`. */
export function lightCommand(argv: readonly string[]): Promise<number> | null {
  const [command, ...rest] = argv;
  if (command === 'status') {
    applyConfiguredTimeZone();
    return import('./daemon-status.js').then((m) => m.statusCommand(rest));
  }
  if (command === 'autostart') {
    applyConfiguredTimeZone();
    return import('./autostart.js').then((m) => m.autostartCommand(rest));
  }
  return null;
}

/** Igual que `runCli` ante un fallo: al registro el detalle, a la consola la frase llana. */
export async function reportLightFatal(err: unknown): Promise<void> {
  const [{ logFile }, { cliFatalMessage }] = await Promise.all([
    import('./log.js'),
    import('./cli-messages.js'),
  ]);
  logFile.error('fatal', { err });
  process.stderr.write(`${cliFatalMessage(err)}\n`);
  process.exitCode = 1;
}

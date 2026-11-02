import { mkdirSync } from 'node:fs';
import { openDaemonControl } from './daemon-control.js';
import type { Lifecycle } from './lifecycle.js';
import { paths } from './paths.js';
import { desktopEnabled } from './platform.js';

/**
 * Tras un cierre ya terminado (control liberado), cuánto se deja a Node para salir solo.
 * Un servidor, socket o intervalo que alguien olvidó cerrar mantenía vivo el proceso: en
 * Windows la tarea seguía «en ejecución», Start-ScheduledTask no abría otra y la
 * autoactualización fallaba con «Windows no llegó a abrir la versión nueva» (2 nov, el
 * panel web). La red de seguridad no retiene el proceso (unref): solo actúa si algo más lo
 * retiene, y dice qué era en el log del lanzador.
 */
export const DAEMON_EXIT_GRACE_MS = 10_000;

export function exitIfStillOpen(code: number, graceMs = DAEMON_EXIT_GRACE_MS): void {
  const timer = setTimeout(() => {
    const left = process.getActiveResourcesInfo().filter((r) => r !== 'TTYWrap');
    process.stderr.write(
      `Asistenta ya se había parado, pero algo seguía abierto (${left.join(', ') || 'nada visible'}): salgo para que pueda volver a arrancar.\n`,
    );
    process.exit(code);
  }, graceMs);
  timer.unref();
}

export interface ControlStartup {
  beginResources(): void;
  attach(lifecycle: Lifecycle): void;
  ready(): void;
}
/** The same ownership wraps both chat and serve, before assertNotRunning. */
export async function controlledDaemon(
  run: (control?: ControlStartup) => Promise<number>,
): Promise<number> {
  if (process.platform !== 'linux' && process.platform !== 'win32') return run();
  if (process.platform === 'linux' && desktopEnabled())
    throw new Error(
      'El control Linux requiere modo servidor (PA_DESKTOP=off); el cierre del micrófono Windows todavía no se puede verificar.',
    );
  // Newly created state is private. Existing open permissions fail closed, not silently changed.
  if (process.platform === 'linux') mkdirSync(paths.state, { mode: 0o700, recursive: true });
  let lifecycle: Lifecycle | undefined;
  const control = await openDaemonControl(paths.state, () => lifecycle?.stop('local-control'));
  let attached = false;
  let resourcesStarted = false;
  try {
    const result = await run({
      beginResources() {
        resourcesStarted = true;
      },
      attach(value) {
        if (attached) throw new Error('Lifecycle ya conectado.');
        lifecycle = value;
        attached = true;
      },
      ready() {
        if (!lifecycle) throw new Error('Lifecycle no conectado.');
        control.ready();
      },
    });
    if (lifecycle && lifecycle.outcome() === 'running') {
      lifecycle.stop('command-finished');
      await lifecycle.done;
    }
    await control.close(lifecycle ? lifecycle.outcome() === 'clean' : undefined);
    const code = lifecycle?.outcome() === 'failed' ? 1 : result;
    if (lifecycle) exitIfStillOpen(code);
    return code;
  } catch (error) {
    if (lifecycle) {
      lifecycle.stop('startup-failed');
      await lifecycle.done;
      await control.close(false);
    }
    if (!lifecycle && !resourcesStarted) await control.close();
    if (!lifecycle && resourcesStarted) {
      // Fail closed: ownership is retained until fatal exit rather than permitting
      // another daemon beside resources whose startup never installed a drainer.
      const fatal = setTimeout(() => process.exit(1), 15_000);
      fatal.unref();
    }
    // Before lifecycle is installed, startup may have opened resources with no known
    // drainer. Keep ownership until process exit instead of allowing an unsafe takeover.
    throw error;
  }
}

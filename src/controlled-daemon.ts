import { mkdirSync } from 'node:fs';
import { openDaemonControl } from './daemon-control.js';
import type { Lifecycle } from './lifecycle.js';
import { paths } from './paths.js';
import { desktopEnabled } from './platform.js';

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
    return lifecycle?.outcome() === 'failed' ? 1 : result;
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

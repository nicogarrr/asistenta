import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { log } from './log.js';
import { paths } from './paths.js';

/**
 * Daemon lifecycle for Windows.
 *
 * The thing that actually breaks here is graceful shutdown: `SIGTERM` is not
 * delivered to a Windows console app the way it is on Linux, and a daemon that
 * dies without releasing its channel sessions gets logged out of WhatsApp. So
 * SIGINT/SIGTERM/SIGBREAK are handled identically, the shutdown is idempotent,
 * and a `.stale` marker records any exit that did not finish — which doubles as
 * the crash counter you want to look at when the logs show unexplained logouts.
 */
export interface LifecycleDeps {
  name: string;
  /** Write paths. Default under the state dir. */
  stateDir?: string;
  /** Hard ceiling on shutdown. After this, exit(1) regardless. */
  shutdownBudgetMs?: number;
  onShutdown: (reason: string) => Promise<void>;
  onStartup?: () => Promise<void> | void;
}

export interface Lifecycle {
  /** Resolves when the process should exit. Await this to block. */
  done: Promise<void>;
  heartbeat: () => Promise<void>;
  stop: (reason: string) => void;
}

function stalePath(stateDir: string, name: string): string {
  return `${stateDir}/${name}.pid.stale`;
}

function pidPath(stateDir: string, name: string): string {
  return `${stateDir}/${name}.pid`;
}

/**
 * Refuse to start if another live process owns this state dir. A second instance
 * racing a first one on the same channel credentials is the documented way to end
 * up logged out of WhatsApp with a `device_removed` conflict.
 *
 * A live pid always refuses, even with a stale marker present: taking over a
 * running daemon orphans its sockets and doubles every side effect. A stale marker
 * with a dead pid means the previous run died uncleanly; it is reported, cleaned,
 * and only then may boot proceed.
 */
export function assertNotRunning(stateDir: string, name: string): void {
  const pidFile = pidPath(stateDir, name);
  if (!existsSync(pidFile)) return;
  const raw = readFileSync(pidFile, 'utf8').trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    log.warn('pid file is unreadable; removing it', { raw: raw.slice(0, 32) });
    try {
      unlinkSync(pidFile);
    } catch {}
    return;
  }
  // In a container the daemon is always PID 1, so the pid file left in the volume by
  // the previous container names THIS process. It cannot be a second instance (we have
  // not written our own file yet), so it is a leftover: reclaim it.
  if (pid === process.pid) {
    log.warn('pid file names this very process (container restart); reclaiming it', { pid });
    for (const f of [stalePath(stateDir, name), pidFile]) {
      try {
        unlinkSync(f);
      } catch {}
    }
    return;
  }
  if (processAlive(pid)) {
    throw new Error(`another ${name} is already running (pid ${pid}); stop it first`);
  }
  if (existsSync(stalePath(stateDir, name))) {
    log.warn('previous instance died without clean shutdown', { pid });
    try {
      unlinkSync(stalePath(stateDir, name));
    } catch {}
  } else {
    log.warn('removing pid file from a dead process', { pid });
  }
  try {
    unlinkSync(pidFile);
  } catch {}
}

/**
 * Is `pid` a live process?
 *
 * On Unix, `kill(pid, 0)` throws EPERM for "alive but not ours to signal", which
 * is a true positive worth keeping. Windows cannot tell that case apart from a
 * dead pid: libuv maps the failure to open the process handle to EPERM either
 * way, so treating EPERM as alive there declares a corpse running and
 * `assertNotRunning` refuses to boot after any exit that did not shut down
 * cleanly (measured on this PC: a killed daemon blocked the next start with
 * "another agent is already running"). On Windows EPERM therefore counts as
 * "not running"; a genuine second instance is caught moments later by the
 * watchdog and by the port the listener needs.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (process.platform === 'win32') return false;
    // EPERM means alive but not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function installLifecycle(deps: LifecycleDeps): Lifecycle {
  const stateDir = deps.stateDir ?? paths.state;
  const budget = deps.shutdownBudgetMs ?? 15_000;
  mkdirSync(stateDir, { recursive: true });

  const pidFile = pidPath(stateDir, deps.name);
  const stale = stalePath(stateDir, deps.name);
  const beatFile = `${stateDir}/${deps.name}.heartbeat`;

  let closing = false;
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const writeAtomic = (file: string, contents: string): void => {
    const tmp = `${file}.tmp`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, contents, 'utf8');
    renameSync(tmp, file); // atomic on NTFS
  };

  const heartbeat = async (): Promise<void> => {
    try {
      writeAtomic(beatFile, String(Date.now()));
    } catch (err) {
      log.warn('heartbeat write failed', { err });
    }
  };

  const stop = (reason: string, code = 0): void => {
    if (closing) return;
    closing = true;
    // Mark the exit as unconfirmed first; the marker is only removed on a clean finish.
    try {
      writeFileSync(stale, `${process.pid} ${reason}\n`, 'utf8');
    } catch {}

    const hard = setTimeout(() => {
      log.error('shutdown budget exceeded, exiting hard', { reason });
      process.exit(1);
    }, budget);
    hard.unref();

    void (async () => {
      try {
        await deps.onShutdown(reason);
        clearTimeout(hard);
        // Removing the marker is the signal that shutdown finished normally.
        try {
          unlinkSync(stale);
        } catch {}
        try {
          unlinkSync(pidFile);
        } catch {}
        process.exitCode = code;
      } catch (err) {
        log.error('shutdown failed', { reason, err });
        clearTimeout(hard);
        process.exitCode = 1;
      } finally {
        resolveDone();
      }
    })();
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(sig, () => stop(sig));
  }
  // SCM hard-stops arrive as a process message, not a signal on Windows.
  process.on('message', (m) => {
    if (m === 'shutdown') stop('scm-shutdown');
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception, shutting down', { err });
    stop('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { err: reason });
  });

  // Exclusive create: two daemons racing through assertNotRunning together must not
  // both proceed. Whoever loses gets EEXIST instead of a second live instance.
  try {
    writeFileSync(pidFile, String(process.pid), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    throw new Error(
      `could not claim ${pidFile} (another instance won the race): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const timer = setInterval(() => void heartbeat(), 15_000);
  timer.unref();
  void heartbeat();

  void (async () => {
    try {
      await deps.onStartup?.();
    } catch (err) {
      log.error('startup failed', { err });
      stop('startup-failed', 1);
    }
  })();

  return { done, heartbeat, stop };
}

export function newRequestId(): string {
  return randomUUID();
}

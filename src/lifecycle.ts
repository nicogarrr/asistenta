import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { uniqueTmpPath } from './fs-tmp.js';
import { log } from './log.js';
import { paths } from './paths.js';
import { formatStartRecord, ownIdentity, sameProcessAsRecorded } from './process-identity.js';

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
  outcome: () => 'running' | 'clean' | 'failed';
}

function stalePath(stateDir: string, name: string): string {
  return `${stateDir}/${name}.pid.stale`;
}

function pidPath(stateDir: string, name: string): string {
  return `${stateDir}/${name}.pid`;
}

/** «<pid> <start identity>» written next to the pid file (see process-identity.ts). */
function startPath(stateDir: string, name: string): string {
  return `${stateDir}/${name}.pid.start`;
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
export function assertNotRunning(
  stateDir: string,
  name: string,
  opts: {
    imageOf?: (pid: number) => string | null;
    identityOf?: (pid: number) => string | null;
  } = {},
): void {
  const pidFile = pidPath(stateDir, name);
  const startFile = startPath(stateDir, name);
  if (!existsSync(pidFile)) {
    try {
      unlinkSync(startFile);
    } catch {}
    return;
  }
  const raw = readFileSync(pidFile, 'utf8').trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    log.warn('pid file is unreadable; removing it', { raw: raw.slice(0, 32) });
    for (const f of [pidFile, startFile]) {
      try {
        unlinkSync(f);
      } catch {}
    }
    return;
  }
  // In a container the daemon is always PID 1, so the pid file left in the volume by
  // the previous container names THIS process. It cannot be a second instance (we have
  // not written our own file yet), so it is a leftover: reclaim it.
  if (pid === process.pid) {
    log.warn('pid file names this very process (container restart); reclaiming it', { pid });
    for (const f of [stalePath(stateDir, name), pidFile, startFile]) {
      try {
        unlinkSync(f);
      } catch {}
    }
    return;
  }
  if (processAlive(pid)) {
    // A pid file left by a crash or a hard exit can name a pid the OS has since
    // handed to an unrelated program (Windows reuses pids quickly). Only a pid
    // whose executable is known NOT to be node is treated as stale; an unknown
    // image keeps refusing. The foreign process is never signalled.
    const image = (opts.imageOf ?? processImageName)(pid);
    if (image === null || isNodeImage(image)) {
      // Another node program (or one we cannot name) may hold the reused pid.
      // The start identity recorded at boot tells them apart: only a live
      // process that provably started at another moment is a stranger.
      const same = sameProcessAsRecorded(startFile, pid, opts.identityOf);
      if (same !== 'different') {
        throw new Error(`another ${name} is already running (pid ${pid}); stop it first`);
      }
      log.warn('pid file names a process that started at another time (pid reused); ignoring it', {
        pid,
      });
    } else {
      log.warn('pid file names a process that is not Asistenta (pid reused); ignoring it', {
        pid,
        image: image.slice(0, 64),
      });
    }
  }
  if (existsSync(stalePath(stateDir, name))) {
    log.warn('previous instance died without clean shutdown', { pid });
    try {
      unlinkSync(stalePath(stateDir, name));
    } catch {}
  } else {
    log.warn('removing pid file from a dead process', { pid });
  }
  for (const f of [pidFile, startFile]) {
    try {
      unlinkSync(f);
    } catch {}
  }
}

/** True for the node executable that runs Asistenta (node, node.exe, this execPath). */
export function isNodeImage(image: string): boolean {
  const b = basename(image.trim()).toLowerCase();
  if (b === '') return false;
  const own = basename(process.execPath).toLowerCase();
  return b === own || /^node(\d+)?(\.exe)?$/.test(b);
}

/** First field of `tasklist /FO CSV /NH` output («"chrome.exe","1234",…»), or null. */
export function parseTasklistImage(out: string, pid: number): string | null {
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && Number(m[2]) === pid) return m[1] ?? null;
  }
  return null;
}

/**
 * Executable name of a live pid, or null when it cannot be told (then the
 * caller stays conservative and refuses to start). Read-only: never signals.
 */
export function processImageName(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return basename(readlinkSync(`/proc/${pid}/exe`));
    }
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      return parseTasklistImage(out, pid);
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    return out === '' ? null : basename(out);
  } catch {
    return null;
  }
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
  const startFile = startPath(stateDir, deps.name);
  const beatFile = `${stateDir}/${deps.name}.heartbeat`;

  let closing = false;
  let outcome: 'running' | 'clean' | 'failed' = 'running';
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  // Claim the pid file FIRST, before any handler is installed: the loser of
  // the race must leave nothing behind - no signal or crash handler whose
  // stop() would later write a .stale marker over the winner's and delete the
  // winner's pid file (which reopens the door to a third instance).
  // Exclusive create: two daemons racing through assertNotRunning together must not
  // both proceed. Whoever loses gets EEXIST instead of a second live instance.
  try {
    writeFileSync(pidFile, String(process.pid), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    throw new Error(
      `could not claim ${pidFile} (another instance won the race): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Record who we are next to the pid, so a later start (or the watchdog) can
  // tell this process from another one that inherits the pid after a crash.
  // Best effort: without it the old, cautious behaviour applies.
  const identity = ownIdentity();
  if (identity !== null) {
    try {
      writeFileSync(startFile, formatStartRecord(process.pid, identity), 'utf8');
    } catch {}
  }
  // Only ever remove the pid file while it still names this process.
  const releasePidFile = (): void => {
    try {
      if (readFileSync(pidFile, 'utf8').trim() !== String(process.pid)) return;
      unlinkSync(pidFile);
      unlinkSync(startFile);
    } catch {}
  };

  const writeAtomic = (file: string, contents: string): void => {
    const tmp = uniqueTmpPath(file);
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
        // Removing the marker is the signal that shutdown finished normally. A
        // stop with a non-zero code (uncaughtException, failed startup) drained
        // fine but is still a crash: the marker stays so the crash counter sees it.
        if (code === 0) {
          try {
            unlinkSync(stale);
          } catch {}
        }
        releasePidFile();
        clearInterval(timer);
        outcome = code === 0 ? 'clean' : 'failed';
        process.exitCode = code;
      } catch (err) {
        log.error('shutdown failed', { reason, err });
        clearTimeout(hard);
        clearInterval(timer);
        outcome = 'failed';
        process.exitCode = 1;
      } finally {
        resolveDone();
      }
    })();
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
    process.on(sig, () => {
      // A second Ctrl+C (or Ctrl+Break) while draining means «now»: exit at once
      // instead of ignoring it for up to the whole shutdown budget. The .stale
      // marker written by the first stop stays, so it counts as unfinished.
      // A repeated SIGTERM (service manager) keeps waiting for the drain.
      if (closing && sig !== 'SIGTERM') {
        log.warn('second interrupt during shutdown, exiting now', { sig });
        process.exit(130);
      }
      stop(sig);
    });
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

  return { done, heartbeat, stop, outcome: () => outcome };
}

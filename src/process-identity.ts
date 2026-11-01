import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Who a pid is, not just whether it is alive. A pid file left by a crash or a
 * hard exit can name a pid the OS has since handed to another program — even
 * another node program — so the daemon records its own start identity next to
 * the pid (`<name>.pid.start`, «<pid> <identity>») and both `assertNotRunning`
 * and the watchdog compare it with the live process before trusting the pid.
 *
 * An identity is a short token:
 * - `proc:<ticks>` on Linux: the process start time from /proc/<pid>/stat, in
 *   clock ticks since boot. Exact; compared for equality.
 * - `ms:<epoch ms>` elsewhere (Windows, macOS): the start time on the wall
 *   clock. Compared with a wide tolerance: a reused pid always started AFTER the
 *   recorded daemon died, so a generous window never confuses two processes.
 *
 * Everything here is read-only: nothing is ever signalled. When the identity
 * cannot be told the answer is 'unknown', and callers keep their old, cautious
 * behaviour.
 */

/** Tolerance for wall-clock identities (`ms:`). */
export const START_TOLERANCE_MS = 10_000;

export type SameProcess = 'same' | 'different' | 'unknown';

/** Start ticks (field 22) from the text of /proc/<pid>/stat, or null. */
export function parseProcStatStart(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const ticks = rest[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
}

/**
 * Start identity of a live pid, or null when it cannot be told. On Windows and
 * macOS this asks the OS once (PowerShell / ps) with a short timeout.
 */
export function processIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const ticks = parseProcStatStart(readFileSync(`/proc/${pid}/stat`, 'utf8'));
      return ticks === null ? null : `proc:${ticks}`;
    }
    if (process.platform === 'win32') {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
      ).trim();
      const ms = Date.parse(out);
      return Number.isFinite(ms) ? `ms:${ms}` : null;
    }
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }).trim();
    const ms = Date.parse(out);
    return out !== '' && Number.isFinite(ms) ? `ms:${ms}` : null;
  } catch {
    return null;
  }
}

/**
 * This process's own identity, in the same scheme `processIdentity` reads for
 * other pids. Outside Linux it is computed from the uptime (no child process
 * is started at boot just to learn our own start time).
 */
export function ownIdentity(): string | null {
  if (process.platform === 'linux') return processIdentity(process.pid);
  return `ms:${Math.round(Date.now() - process.uptime() * 1000)}`;
}

/** Compares two identity tokens. Different schemes or unreadable tokens: 'unknown'. */
export function compareIdentity(recorded: string, current: string | null): SameProcess {
  if (current === null) return 'unknown';
  const a = /^(proc|ms):(\d+)$/.exec(recorded.trim());
  const b = /^(proc|ms):(\d+)$/.exec(current.trim());
  if (!a || !b || a[1] !== b[1]) return 'unknown';
  if (a[1] === 'proc') return a[2] === b[2] ? 'same' : 'different';
  return Math.abs(Number(a[2]) - Number(b[2])) <= START_TOLERANCE_MS ? 'same' : 'different';
}

/** «<pid> <identity>» as written next to the pid file. */
export function formatStartRecord(pid: number, identity: string): string {
  return `${pid} ${identity}\n`;
}

/**
 * Is the live `pid` the process recorded in `startFile`? 'unknown' when the
 * file is missing, unreadable, was written for another pid, or the live
 * process's identity cannot be read.
 */
export function sameProcessAsRecorded(
  startFile: string,
  pid: number,
  identityOf: (pid: number) => string | null = processIdentity,
): SameProcess {
  let raw: string;
  try {
    raw = readFileSync(startFile, 'utf8').trim();
  } catch {
    return 'unknown';
  }
  const m = /^(\d+)\s+(\S+)$/.exec(raw);
  if (!m || Number(m[1]) !== pid || m[2] === undefined) return 'unknown';
  return compareIdentity(m[2], identityOf(pid));
}

/**
 * Who opened a connection to the probe's test server: the browser, or something else?
 *
 * The probe's checks need proof that the browser really did each step. The page reports
 * its steps back to the server, but the attempt's own code knows the server's address and
 * could send those reports itself with a browser-like User-Agent. On Linux the kernel
 * knows which process holds each socket, so we ask it: the client end of the connection
 * is looked up in /proc/net/tcp and then among the open files of every process we can read.
 *
 * A name is not proof: the attempt could copy Node (or curl) to a file called «chrome».
 * So the program must also be a browser Playwright installed (inside its browsers folder),
 * must not be Node under another name, must run under the probe's agent process, and every
 * connection must come from one and the same browser.
 *
 * browser: true  = the socket belongs to that browser
 * browser: false = it belongs to some other program, or to a second browser
 * browser: null  = this system can't say; the caller falls back to the User-Agent
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, sep } from 'node:path';
import { playwrightBrowsersPath } from '../src/evolve/browsers-path.js';

const BROWSER_EXE = /chrom|headless_shell|msedge|firefox/i;

function socketInode(clientPort: number, serverPort: number): string | null {
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      const local = Number.parseInt(f[1]?.split(':')[1] ?? '', 16);
      const remote = Number.parseInt(f[2]?.split(':')[1] ?? '', 16);
      if (local === clientPort && remote === serverPort && f[9] && f[9] !== '0') return f[9];
    }
  }
  return null;
}

function socketPid(inode: string): number | null {
  const target = `socket:[${inode}]`;
  let pids: string[] = [];
  try {
    pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p));
  } catch {
    return null;
  }
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(`/proc/${pid}/fd/${fd}`) === target) return Number(pid);
      } catch {}
    }
  }
  return null;
}

/** What the probe needs to know about a process. Swappable in tests. */
export type ProcInfo = { exe(pid: number): string | null; ppid(pid: number): number | null };

export const linuxProc: ProcInfo = {
  exe: (pid) => {
    try {
      return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
    } catch {
      return null;
    }
  },
  ppid: (pid) => {
    try {
      const m = /^PPid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  },
};

const hashes = new Map<string, string>();
function fileHash(path: string): string | null {
  try {
    const st = statSync(path);
    const key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
    const known = hashes.get(key);
    if (known) return known;
    const h = createHash('sha256').update(readFileSync(path)).digest('hex');
    hashes.set(key, h);
    return h;
  } catch {
    return null;
  }
}

/** Is this file Node itself (a link or a copy of the program running the probe)? */
export function isNodeInDisguise(exe: string, node: string = process.execPath): boolean {
  try {
    const a = statSync(exe);
    const b = statSync(node);
    if (a.dev === b.dev && a.ino === b.ino) return true;
    if (a.size !== b.size) return false;
    const ha = fileHash(exe);
    return ha !== null && ha === fileHash(node);
  } catch {
    return false;
  }
}

/** The folder Playwright installs its browsers into, resolved (null if unknown). */
export function browsersFolder(env: NodeJS.ProcessEnv = process.env): string | null {
  let dir = playwrightBrowsersPath(env);
  if (dir === '0') {
    try {
      dir = join(
        dirname(realpathSync(join('node_modules', 'playwright-core', 'package.json'))),
        '.local-browsers',
      );
    } catch {
      return null;
    }
  }
  if (!dir) return null;
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

function inside(file: string, dir: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    // Windows paths: either slash, any case.
    const f = file.replace(/\//g, '\\').toLowerCase();
    const d = dir.replace(/\//g, '\\').toLowerCase();
    return f.startsWith(d.endsWith('\\') ? d : `${d}\\`);
  }
  let real = file;
  try {
    real = realpathSync(file);
  } catch {}
  return real.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** The topmost ancestor still running the same program: the browser's main process. */
export function browserRoot(pid: number, proc: ProcInfo = linuxProc): number {
  const exe = proc.exe(pid);
  let root = pid;
  for (let i = 0; i < 64; i++) {
    const parent = proc.ppid(root);
    if (!parent || parent <= 1 || proc.exe(parent) !== exe) break;
    root = parent;
  }
  return root;
}

/** Does pid run under ancestor (or is it ancestor)? */
export function descendsFrom(pid: number, ancestor: number, proc: ProcInfo = linuxProc): boolean {
  let p: number | null = pid;
  for (let i = 0; p && p > 1 && i < 128; i++) {
    if (p === ancestor) return true;
    p = proc.ppid(p);
  }
  return false;
}

export type Verdict = { browser: boolean | null; root?: number };

/** Judges a process already known to own the connection. */
export function judgeProcess(
  pid: number,
  opts: {
    agentPid?: number;
    folder?: string | null;
    proc?: ProcInfo;
    node?: string;
    platform?: NodeJS.Platform;
  } = {},
): Verdict {
  const proc = opts.proc ?? linuxProc;
  const exe = proc.exe(pid);
  if (!exe) return { browser: null };
  if (!BROWSER_EXE.test(exe.split(/[\\/]/).pop() ?? '')) return { browser: false };
  if (isNodeInDisguise(exe, opts.node)) return { browser: false };
  const folder = opts.folder === undefined ? browsersFolder() : opts.folder;
  if (folder && !inside(exe, folder, opts.platform ?? process.platform)) return { browser: false };
  if (opts.agentPid && !descendsFrom(pid, opts.agentPid, proc)) return { browser: false };
  return { browser: true, root: browserRoot(pid, proc) };
}

export function connectionOwner(
  clientPort: number,
  serverPort: number,
  opts: { agentPid?: number } = {},
): Verdict {
  if (process.platform !== 'linux') return { browser: null };
  const inode = socketInode(clientPort, serverPort);
  if (!inode) return { browser: null };
  const pid = socketPid(inode);
  if (!pid) return { browser: null };
  return judgeProcess(pid, opts);
}

export function connectionFromBrowser(clientPort: number, serverPort: number): boolean | null {
  return connectionOwner(clientPort, serverPort).browser;
}

/**
 * Does the lookup work on this system? It asks about a connection of our own, which must
 * come out as «not a browser». The probe only trusts the User-Agent where it can't.
 */
export async function ownerLookupWorks(
  look: (
    clientPort: number,
    serverPort: number,
  ) => boolean | null | Promise<boolean | null> = connectionFromBrowser,
  waitMs = 20_000,
): Promise<boolean> {
  const server = createServer();
  let verdict: boolean | null = null;
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const judged = new Promise<void>((resolve) =>
      server.once('connection', async (s) => {
        verdict = await look(s.remotePort ?? 0, port);
        s.destroy();
        resolve();
      }),
    );
    const client = connect(port, '127.0.0.1');
    client.on('error', () => {});
    await Promise.race([judged, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
    client.destroy();
  } catch {
    verdict = null;
  } finally {
    server.close();
  }
  return verdict === false;
}

/**
 * Does a request count as the browser's? Where the lookup works, only a connection proven
 * to be the browser's counts: one whose owner is already gone (opened, written and closed
 * at once by a short-lived program) proves nothing. Elsewhere, the User-Agent as before.
 */
export function countsAsBrowser(
  ua: boolean,
  who: boolean | null | undefined,
  lookupWorks: boolean,
): boolean {
  if (!ua) return false;
  return lookupWorks ? who === true : who !== false;
}

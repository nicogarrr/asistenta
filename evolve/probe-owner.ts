/**
 * Who opened a connection to the probe's test server: the browser, or something else?
 *
 * The probe's checks need proof that the browser really did each step. The page reports
 * its steps back to the server, but the attempt's own code knows the server's address and
 * could send those reports itself with a browser-like User-Agent. On Linux the kernel
 * knows which process holds each socket, so we ask it: the client end of the connection
 * is looked up in /proc/net/tcp and then among the open files of every process we can read.
 *
 * true  = the socket belongs to a browser process (chrome, headless_shell, msedge, firefox)
 * false = it belongs to some other process (node, curl, python...): not the browser
 * null  = this system can't say (not Linux, or the owner is not readable); the caller falls
 *         back to the User-Agent, as before
 */
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

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

export function connectionFromBrowser(clientPort: number, serverPort: number): boolean | null {
  if (process.platform !== 'linux') return null;
  const inode = socketInode(clientPort, serverPort);
  if (!inode) return null;
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
      let link = '';
      try {
        link = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (link !== target) continue;
      let exe = '';
      try {
        exe = readlinkSync(`/proc/${pid}/exe`);
      } catch {
        return null;
      }
      return BROWSER_EXE.test(exe.split('/').pop() ?? '');
    }
  }
  return null;
}

/**
 * Who opened a connection to the probe's server, on Windows and macOS. There is no /proc,
 * so we ask the system's own tools: `netstat -ano` (Windows) or `lsof` (macOS) say which
 * process holds the client end, and the process table (Win32_Process / `ps`) gives each
 * process's program and parent. The verdict is then the same one Linux uses (judgeProcess).
 */
import { execFile } from 'node:child_process';
import { connectionOwner, judgeProcess, type ProcInfo, type Verdict } from './probe-owner.js';

export type Run = (cmd: string, args: string[]) => Promise<string>;

const defaultRun: Run = (cmd, args) =>
  new Promise((resolve) =>
    execFile(
      cmd,
      args,
      { timeout: 15_000, windowsHide: true, maxBuffer: 16 << 20, encoding: 'utf8' },
      (err, out) => resolve(err ? '' : String(out)),
    ),
  );

const portOf = (addr: string): number => Number(addr.slice(addr.lastIndexOf(':') + 1));

/** `netstat -ano -p TCP`: «TCP  127.0.0.1:52345  127.0.0.1:8080  ESTABLISHED  1234». */
export function pidFromNetstat(
  text: string,
  clientPort: number,
  serverPort: number,
): number | null {
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^TCP/i.test(f[0] ?? '')) continue;
    if (portOf(f[1] ?? '') === clientPort && portOf(f[2] ?? '') === serverPort) {
      const pid = Number(f[f.length - 1]);
      return pid > 0 ? pid : null;
    }
  }
  return null;
}

/** `lsof -nP -iTCP -sTCP:ESTABLISHED -Fpn`: «p1234» then «n127.0.0.1:52345->127.0.0.1:8080». */
export function pidFromLsof(text: string, clientPort: number, serverPort: number): number | null {
  let pid: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null;
    else if (line.startsWith('n') && line.includes('->')) {
      const [a = '', b = ''] = line.slice(1).split('->');
      if (portOf(a) === clientPort && portOf(b) === serverPort) return pid;
    }
  }
  return null;
}

/** «pid ppid program» per line (tab- or space-separated; the program may contain spaces). */
export function procTable(text: string): ProcInfo {
  const rows = new Map<number, { ppid: number; exe: string }>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), exe: m[3] ?? '' });
  }
  return {
    // Only a full path can be checked; anything else means «can't say».
    exe: (pid) => {
      const exe = rows.get(pid)?.exe ?? '';
      return /^(\/|[a-zA-Z]:\\)/.test(exe) ? exe : null;
    },
    ppid: (pid) => rows.get(pid)?.ppid ?? null,
  };
}

const PS_WIN =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0}`t{1}`t{2}' -f $_.ProcessId,$_.ParentProcessId,$_.ExecutablePath }";

export async function connectionOwnerOs(
  clientPort: number,
  serverPort: number,
  opts: {
    agentPid?: number;
    platform?: NodeJS.Platform;
    run?: Run;
    folder?: string | null;
    node?: string;
  } = {},
): Promise<Verdict> {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  let pid: number | null = null;
  let table = '';
  if (platform === 'win32') {
    pid = pidFromNetstat(await run('netstat', ['-ano', '-p', 'TCP']), clientPort, serverPort);
    if (pid)
      table = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_WIN]);
  } else if (platform === 'darwin') {
    pid = pidFromLsof(
      await run('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpn']),
      clientPort,
      serverPort,
    );
    if (pid) table = await run('ps', ['-axo', 'pid=,ppid=,comm=']);
  } else return { browser: null };
  if (!pid || !table) return { browser: null };
  return judgeProcess(pid, {
    agentPid: opts.agentPid,
    folder: opts.folder,
    node: opts.node,
    platform,
    proc: procTable(table),
  });
}

/** The owner of a connection on any system: /proc on Linux, the system's tools elsewhere. */
export async function connectionOwnerAny(
  clientPort: number,
  serverPort: number,
  opts: { agentPid?: number } = {},
): Promise<Verdict> {
  if (process.platform === 'linux') return connectionOwner(clientPort, serverPort, opts);
  return connectionOwnerOs(clientPort, serverPort, opts);
}

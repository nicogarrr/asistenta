/**
 * Who opened a connection to the probe's server, on Windows and macOS. There is no /proc,
 * so we ask the system's own tools: `netstat -ano` (Windows) or `lsof` (macOS) say which
 * process holds the client end, and the process table (Win32_Process / `ps`) gives each
 * process's program and parent. The verdict is then the same one Linux uses (judgeProcess).
 */
import { execFile } from 'node:child_process';
import { connectionOwner, judgeProcess, type ProcInfo, type Verdict } from './probe-owner.js';

export type Run = (cmd: string, args: string[], timeoutMs?: number) => Promise<string>;

const defaultRun: Run = (cmd, args, timeoutMs = 15_000) =>
  new Promise((resolve) =>
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20, encoding: 'utf8' },
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

/** How long each system tool may take. A slow PC gets time instead of a silent downgrade. */
export const NETSTAT_MS = 10_000;
export const TABLE_MS = 30_000;
/** The self-test must wait for both, or a slow first lookup falls back to the User-Agent. */
export const OWNER_LOOKUP_WAIT_MS = NETSTAT_MS + TABLE_MS + 5_000;

export type OwnerLookup = ((
  clientPort: number,
  serverPort: number,
  o?: { agentPid?: number },
) => Promise<Verdict>) & {
  /** Why the last lookup could not answer (plain words), or null. */
  problem: () => string | null;
};

export type LookupOpts = {
  platform?: NodeJS.Platform;
  run?: Run;
  folder?: string | null;
  node?: string;
  netstatMs?: number;
  tableMs?: number;
  /** A process table younger than this is reused for a PID it already lists. */
  tableTtlMs?: number;
  /** Lookups asked within this window share one snapshot taken after all of them. */
  batchMs?: number;
  /** Called once per distinct reason a lookup could not answer. */
  onProblem?: (why: string) => void;
  now?: () => number;
};

/** One snapshot for every caller that asked before it started (never an older one). */
function batched<T>(fn: () => Promise<T>, waitMs: number): () => Promise<T> {
  let next: Promise<T> | null = null;
  return () => {
    next ??= new Promise<void>((r) => setTimeout(r, waitMs)).then(() => {
      next = null;
      return fn();
    });
    return next;
  };
}

/**
 * The lookup for one probe run on Windows/macOS. Connections that arrive together share
 * one netstat/lsof call, and the process table (PowerShell on Windows, about a second) is
 * read once and reused for PIDs it already lists, so a run costs a few calls instead of
 * one per connection. Every call has a bound; when one runs out the reason is kept.
 */
export function ownerLookupOs(opts: LookupOpts = {}): OwnerLookup {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  const now = opts.now ?? Date.now;
  const ttl = opts.tableTtlMs ?? 15_000;
  const batchMs = opts.batchMs ?? 20;
  let last: string | null = null;
  const told = new Set<string>();
  const note = (why: string): null => {
    last = why;
    if (!told.has(why)) {
      told.add(why);
      opts.onProblem?.(why);
    }
    return null;
  };
  const timed = (cmd: string, args: string[], ms: number): Promise<string | null> =>
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      t.unref?.();
      run(cmd, args, ms).then(
        (o) => {
          clearTimeout(t);
          resolve(o);
        },
        () => {
          clearTimeout(t);
          resolve('');
        },
      );
    });
  const ask = async (cmd: string, args: string[], ms: number): Promise<string | null> => {
    const out = await timed(cmd, args, ms);
    if (out === null) return note(`${cmd} tardó más de ${Math.ceil(ms / 1000)} s`);
    if (!out.trim()) return note(`${cmd} no respondió`);
    return out;
  };
  const win = platform === 'win32';
  const conns = batched(
    () =>
      win
        ? ask('netstat', ['-ano', '-p', 'TCP'], opts.netstatMs ?? NETSTAT_MS)
        : ask('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fpn'], opts.netstatMs ?? NETSTAT_MS),
    batchMs,
  );
  let table: { at: number; proc: ProcInfo } | null = null;
  const loadTable = batched(async () => {
    const out = win
      ? await ask(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', PS_WIN],
          opts.tableMs ?? TABLE_MS,
        )
      : await ask('ps', ['-axo', 'pid=,ppid=,comm='], opts.tableMs ?? TABLE_MS);
    if (out) table = { at: now(), proc: procTable(out) };
    return out ? table : null;
  }, batchMs);
  const tableFor = async (pid: number): Promise<ProcInfo | null> => {
    // A recent table that already lists this PID is enough; a new process needs a new one.
    if (table && now() - table.at < ttl && table.proc.ppid(pid) !== null) return table.proc;
    const t = await loadTable();
    return t?.proc ?? null;
  };
  const lookup = async (
    clientPort: number,
    serverPort: number,
    o: { agentPid?: number } = {},
  ): Promise<Verdict> => {
    if (platform !== 'win32' && platform !== 'darwin') return { browser: null };
    const text = await conns();
    if (text === null) return { browser: null };
    const pid = win
      ? pidFromNetstat(text, clientPort, serverPort)
      : pidFromLsof(text, clientPort, serverPort);
    if (!pid) {
      note(`${win ? 'netstat' : 'lsof'} no encontró la conexión`);
      return { browser: null };
    }
    const proc = await tableFor(pid);
    if (!proc) return { browser: null };
    last = null;
    return judgeProcess(pid, {
      agentPid: o.agentPid,
      folder: opts.folder,
      node: opts.node,
      platform,
      proc,
    });
  };
  return Object.assign(lookup, { problem: () => last });
}

export async function connectionOwnerOs(
  clientPort: number,
  serverPort: number,
  opts: LookupOpts & { agentPid?: number } = {},
): Promise<Verdict> {
  return ownerLookupOs(opts)(clientPort, serverPort, { agentPid: opts.agentPid });
}

/** The lookup for this system: /proc on Linux, the system's tools elsewhere. */
export function ownerLookupAny(opts: LookupOpts = {}): OwnerLookup {
  if ((opts.platform ?? process.platform) !== 'linux') return ownerLookupOs(opts);
  let last: string | null = null;
  const lookup = async (c: number, s: number, o: { agentPid?: number } = {}) => {
    const v = connectionOwner(c, s, o);
    last = v.browser === null ? 'el sistema no dice de quién es la conexión' : null;
    return v;
  };
  return Object.assign(lookup, { problem: () => last });
}

/** The owner of a connection on any system: /proc on Linux, the system's tools elsewhere. */
export async function connectionOwnerAny(
  clientPort: number,
  serverPort: number,
  opts: { agentPid?: number } = {},
): Promise<Verdict> {
  return ownerLookupAny()(clientPort, serverPort, opts);
}

/** The line the probe prints when it has to fall back to the User-Agent (null if it doesn't). */
export function fallbackNote(lookupWorks: boolean, problem: string | null): string | null {
  if (lookupWorks) return null;
  return `No se puede comprobar qué programa habla con la prueba (${problem ?? 'el sistema no lo dice'}); solo se mira el User-Agent, que el intento podría imitar.`;
}

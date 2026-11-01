import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';

/**
 * Cerrar lo que el intento deja en marcha.
 *
 * El proponente es un programa cualquiera y el código del intento corre durante la medición:
 * cualquiera de los dos puede dejar un proceso vivo (en segundo plano, con setsid, como hijo
 * huérfano). execFile solo mata al hijo directo al vencer su tiempo, así que ese proceso
 * seguía vivo mientras se medía el intento y después: podía cambiar la copia, el informe o
 * la sonda a mitad de medición. Aquí se buscan y se matan antes de medir y después de medir.
 *
 * Un proceso es del intento si su carpeta de trabajo está dentro de la copia, si lleva en su
 * entorno PA_EVOLVE_SANDBOX=<copia> (lo ponen el proponente y la medición), o si desciende de
 * uno de ellos. En Linux se lee /proc; en Windows, la línea de órdenes de cada proceso (no se
 * puede leer su entorno ni su carpeta) y sus descendientes; en macOS, solo los descendientes de
 * procesos cuya orden nombra la copia. Nunca se toca este proceso ni sus antepasados.
 */

export const SANDBOX_ENV = 'PA_EVOLVE_SANDBOX';

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Carpeta de trabajo, si se pudo leer. */
  cwd?: string;
  /** Lleva PA_EVOLVE_SANDBOX=<copia> en su entorno. */
  marked?: boolean;
  /** Línea de órdenes, si se pudo leer. */
  cmd?: string;
  /** Cuándo se creó (ms desde 1970), si el sistema lo dice (Windows). */
  created?: number;
}

/**
 * Los procesos que lanzamos nosotros para el intento (el proponente, la suite, la sonda).
 * En Windows un huérfano no cambia de padre: su ParentProcessId sigue siendo el pid del
 * proceso que lo lanzó, aunque ya haya terminado. Recordando nuestros pid (con cuándo
 * empezaron y terminaron) se encuentran sus hijos aunque su orden no nombre la copia.
 */
export interface AttemptRoot {
  pid: number;
  /** Cuándo lo lanzamos. */
  at: number;
  /** Cuándo terminó, si ya terminó. */
  end?: number;
}

const rootsByDir = new Map<string, AttemptRoot[]>();

/** Apunta un proceso lanzado para el intento en `dir`; devuelve con qué marcar que terminó. */
export function noteAttemptRoot(
  dir: string,
  pid: number | undefined,
  now: () => number = Date.now,
): () => void {
  if (!pid) return () => {};
  const root: AttemptRoot = { pid, at: now() };
  const list = rootsByDir.get(dir) ?? [];
  list.push(root);
  rootsByDir.set(dir, list);
  // Solo hacen falta los de las últimas copias.
  while (rootsByDir.size > 20) rootsByDir.delete(rootsByDir.keys().next().value as string);
  return () => {
    root.end ??= now();
  };
}

export function attemptRoots(dir: string): AttemptRoot[] {
  return rootsByDir.get(dir) ?? [];
}

// Margen para relojes y redondeos al comparar fechas de creación.
const SLACK_MS = 2000;

const norm = (p: string, win: boolean): string => {
  const s = p.replace(/[\\/]+$/, '');
  // En Windows «C:/a/b», «C:\\a\\b» (escapado) y «C:\a\b» son la misma carpeta.
  return win ? s.replace(/[\\/]+/g, '\\').toLowerCase() : s;
};

function inside(path: string, dirs: string[], win: boolean): boolean {
  const p = norm(path, win);
  const s = win ? '\\' : sep;
  return dirs.some((d) => p === d || p.startsWith(d + s));
}

/** Los pid del intento: marcados, con carpeta o línea de órdenes en la copia, y sus descendientes. */
export function pickAttempt(
  procs: ProcInfo[],
  dir: string,
  self: number = process.pid,
  win: boolean = process.platform === 'win32',
  roots: AttemptRoot[] = [],
): number[] {
  const dirs = [...new Set([dir, safeReal(dir)].map((d) => norm(d, win)))];
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const protectedPids = new Set<number>();
  for (let p: number | undefined = self; p && !protectedPids.has(p); p = parent.get(p)) {
    protectedPids.add(p);
  }
  const chosen = new Set<number>();
  // Nuestros procesos raíz (solo con fecha de creación, para no confundirlos con otro que
  // haya heredado su pid): vivos son del intento; sus hijos, si nacieron mientras vivía.
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const anchors = new Map<number, AttemptRoot>();
  for (const r of roots) {
    const live = byPid.get(r.pid);
    if (live) {
      if (live.created === undefined || Math.abs(live.created - r.at) > SLACK_MS) continue;
      chosen.add(r.pid);
    }
    anchors.set(r.pid, r);
  }
  const bornUnder = (p: ProcInfo): boolean => {
    const r = anchors.get(p.ppid);
    return (
      !!r &&
      p.created !== undefined &&
      p.created >= r.at - SLACK_MS &&
      p.created <= (r.end ?? Number.POSITIVE_INFINITY) + SLACK_MS
    );
  };
  for (const p of procs) {
    const cmd = p.cmd ? (win ? norm(p.cmd, true) : p.cmd) : '';
    if (
      p.marked ||
      (p.cwd && inside(p.cwd, dirs, win)) ||
      (cmd && dirs.some((d) => cmd.includes(d)))
    ) {
      chosen.add(p.pid);
    }
  }
  // Descendientes: un hijo del intento es del intento aunque haya cambiado de carpeta.
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (!chosen.has(p.pid) && (chosen.has(p.ppid) || bornUnder(p))) {
        chosen.add(p.pid);
        grew = true;
      }
    }
  }
  return [...chosen].filter((pid) => !protectedPids.has(pid));
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function listLinux(dir: string): ProcInfo[] {
  const mark = Buffer.from(`${SANDBOX_ENV}=${dir}\0`);
  const out: ProcInfo[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      // «pid (orden) estado ppid …»: la orden puede llevar espacios y paréntesis.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const info: ProcInfo = { pid, ppid };
      try {
        info.cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // de otro usuario o ya terminado
      }
      try {
        const env = readFileSync(`/proc/${pid}/environ`);
        info.marked =
          env.indexOf(mark) === 0 || env.includes(Buffer.concat([Buffer.from('\0'), mark]));
      } catch {
        // idem
      }
      out.push(info);
    } catch {
      // terminó mientras se leía
    }
  }
  return out;
}

type WinRow = {
  ProcessId: number;
  ParentProcessId: number;
  CommandLine?: string | null;
  CreationDate?: string | null;
};

/** «/Date(1698765432100)/» (PowerShell 5) o una fecha ISO (PowerShell 7). */
function winDate(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const m = /\/Date\((-?\d+)/.exec(v);
  const t = m ? Number(m[1]) : Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

export function parseWindowsProcs(text: string): ProcInfo[] {
  const rows = JSON.parse(text || '[]') as WinRow[] | WinRow;
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
    pid: r.ProcessId,
    ppid: r.ParentProcessId,
    cmd: r.CommandLine ?? undefined,
    created: winDate(r.CreationDate),
  }));
}

function listWindows(): ProcInfo[] {
  const ps =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress';
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseWindowsProcs(text);
}

function listPosix(): ProcInfo[] {
  const text = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return text
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
}

export function listProcesses(dir: string): ProcInfo[] {
  if (process.platform === 'linux') return listLinux(dir);
  if (process.platform === 'win32') return listWindows();
  return listPosix();
}

function killHard(pid: number): void {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 30_000,
    });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

/**
 * Mata los procesos del intento y devuelve cuántos. Se repite unas vueltas, porque uno puede
 * lanzar otro mientras se matan los demás. Si no se puede listar, devuelve -1: quien llama
 * decide (una medición con procesos del intento sin cerrar no es fiable).
 */
export function reapAttempt(
  dir: string,
  deps: { list?: (dir: string) => ProcInfo[]; kill?: (pid: number) => void } = {},
): number {
  const list = deps.list ?? listProcesses;
  const kill = deps.kill ?? killHard;
  let total = 0;
  for (let round = 0; round < 5; round++) {
    let pids: number[];
    try {
      pids = pickAttempt(
        list(dir),
        dir,
        process.pid,
        process.platform === 'win32',
        attemptRoots(dir),
      );
    } catch {
      return -1;
    }
    if (!pids.length) return total;
    for (const pid of pids) {
      try {
        kill(pid);
        total++;
      } catch {
        // ya había terminado
      }
    }
  }
  return total;
}

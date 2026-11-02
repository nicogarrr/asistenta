/**
 * Una sola Asistenta a la vez en el PC.
 *
 * Nico (2 nov): dos grupos «Windows PowerShell» en el Administrador de tareas, cada uno con
 * su node, y respuestas repetidas en Telegram. Dos daemons con el mismo bot se reparten (y
 * repiten) los mensajes. Dentro de una carpeta de estado ya hay candado (agent.pid y el
 * control del daemon), pero un proceso que se quedó vivo tras pararse, u otra instalación
 * (el .exe en %LOCALAPPDATA%\Asistenta y la carpeta de git) no lo ven.
 *
 * Aquí se buscan, por su línea de órdenes, SOLO los procesos de Asistenta:
 * - daemons: node con `dist\cli.js` o `dist\pa.js` y la orden `serve` o `iniciar`;
 * - lanzadores: PowerShell con `deploy\windows\run-hidden.ps1` o `run-stack.ps1`.
 * Nunca otro node ni otro PowerShell. Para cerrarlos, primero se pide a cada uno un cierre
 * limpio con SU propio `pa stop` (su carpeta, su .env); lo que siga vivo se cierra a la
 * fuerza, primero los daemons y después sus lanzadores.
 *
 * Sin dependencias de Asistenta (solo node:*): el instalador lo ejecuta con el node de la
 * instalación vieja antes de copiar la nueva.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
}

const DAEMON =
  /^(?:"([^"]+)"|(\S+))\s+(?:.*?\s)?"?((?:[^"]*?[\\/])?)dist[\\/](?:cli|pa)\.js"?\s+(?:serve|iniciar)(?:\s|$)/i;
const LAUNCHER =
  /"([^"]*?)[\\/]deploy[\\/]windows[\\/]run-(?:hidden|stack)\.ps1"|(\S*?)[\\/]deploy[\\/]windows[\\/]run-(?:hidden|stack)\.ps1\b/i;

/**
 * ¿Es de verdad una carpeta de Asistenta? Ruta absoluta con su package.json
 * («personal-agent»). Un `dist\cli.js serve` de otro programa no se toca nunca, ni una
 * ruta relativa que no se puede comprobar.
 */
export function isAsistentaRepo(
  repo: string,
  read: (file: string) => string = (f) => readFileSync(f, 'utf8'),
): boolean {
  if (!repo || !isAbsolute(repo)) return false;
  try {
    return (
      (JSON.parse(read(join(repo, 'package.json'))) as { name?: unknown }).name === 'personal-agent'
    );
  } catch {
    return false;
  }
}

function base(name: string): string {
  return (name.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
}

/** ¿Es un daemon de Asistenta? Devuelve el node que lo corre y la carpeta de la app. */
export function daemonOf(p: ProcInfo): { node: string; repo: string } | null {
  const m = DAEMON.exec(p.cmd.trim());
  if (!m) return null;
  const node = m[1] ?? m[2] ?? '';
  // En Linux el nombre del proceso es el del hilo («MainThread»): vale el ejecutable de la orden.
  if (!isNode(p.name) && !isNode(node)) return null;
  const repo = (m[3] ?? '').replace(/[\\/]$/, '');
  return { node, repo };
}

function isNode(exe: string): boolean {
  return /^node\d*$/.test(base(exe));
}

/** ¿Es un lanzador de Asistenta (run-hidden/run-stack.ps1)? Devuelve la carpeta de la app. */
export function launcherOf(p: ProcInfo): { repo: string } | null {
  const b = base(p.name);
  if (b !== 'powershell' && b !== 'pwsh') return null;
  const m = LAUNCHER.exec(p.cmd);
  return m ? { repo: (m[1] ?? m[2] ?? '').replace(/^"/, '') } : null;
}

/** Los daemons y lanzadores de Asistenta de la lista, sin este proceso ni sus padres. */
export function asistentaInstances(
  list: readonly ProcInfo[],
  exclude: readonly number[] = [process.pid, process.ppid],
  isOurs: (repo: string) => boolean = isAsistentaRepo,
): { daemons: ProcInfo[]; launchers: ProcInfo[] } {
  const skip = new Set(exclude);
  const mine = list.filter((p) => !skip.has(p.pid));
  const daemonRepo = (p: ProcInfo) => daemonOf(p)?.repo;
  const launcherRepo = (p: ProcInfo) => launcherOf(p)?.repo;
  return {
    daemons: mine.filter((p) => {
      const repo = daemonRepo(p);
      return repo !== undefined && isOurs(repo);
    }),
    launchers: mine.filter((p) => {
      const repo = launcherRepo(p);
      return repo !== undefined && isOurs(repo);
    }),
  };
}

/**
 * Las comprobaciones de procesos solo corren en Windows (el PC de Nico): en Linux/macOS
 * (pruebas, contenedor) varias copias de desarrollo conviven a propósito y nunca se cierran.
 */
export function instanceChecksEnabled(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) =>
    p
      .replace(/[\\/]+/g, '/')
      .replace(/\/$/, '')
      .toLowerCase();
  return norm(a) === norm(b);
}

/** La carpeta de esta Asistenta (dist\instancias.js → la de encima de dist). */
export function ownRepo(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Al arrancar `serve`: ¿hay otra Asistenta de OTRA carpeta en marcha (el .exe y la carpeta
 * de git, o una copia vieja)? Dos daemons con el mismo bot leen los mismos mensajes de
 * Telegram antes de que ninguno los dé por leídos, y los dos contestan: el doble «No había
 * nada en curso.» al /stop del 2 nov. La de la MISMA carpeta ya la para agent.pid
 * (lifecycle.ts). Devuelve el motivo para no arrancar, o null.
 */
export async function otherInstanceReason(
  opts: {
    list?: () => Promise<ProcInfo[]>;
    repo?: string;
    exclude?: readonly number[];
    isOurs?: (repo: string) => boolean;
  } = {},
): Promise<string | null> {
  const repo = opts.repo ?? ownRepo();
  const all = await (opts.list ?? listProcesses)().catch(() => [] as ProcInfo[]);
  const other = asistentaInstances(all, opts.exclude, opts.isOurs).daemons.find((d) => {
    const of = daemonOf(d);
    return of !== null && !sameFolder(of.repo, repo);
  });
  if (!other) return null;
  return `Ya hay otra Asistenta en marcha (proceso ${other.pid}, carpeta ${daemonOf(other)?.repo}): no arranco una segunda, porque contestaríais dos veces en Telegram. Párala con pa stop en esa carpeta, o ejecuta pa autostart install --start, que cierra las de más y deja una.`;
}

/** «N instancias de Asistenta en marcha» para `pa doctor`; null con una o ninguna. */
export function instancesDoctorLine(daemons: number): string | null {
  if (daemons <= 1) return null;
  return `instancias      ${daemons} instancias de Asistenta en marcha: sobran ${daemons - 1}. Responden dos veces y se pisan. Arréglalo con pa autostart install --start (cierra las de más y deja una).`;
}

function run(exe: string, args: string[], timeout: number, cwd?: string) {
  return new Promise<{ ok: boolean; out: string }>((resolve) => {
    execFile(
      exe,
      args,
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, cwd },
      (error, stdout) => resolve({ ok: !error, out: String(stdout ?? '') }),
    );
  });
}

/** Salida JSON de Win32_Process (un objeto o una lista) → ProcInfo. */
export function parseWindowsList(json: string): ProcInfo[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return rows.flatMap((r) => {
    const o = r as Record<string, unknown>;
    const pid = Number(o.ProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0) return [];
    return [
      {
        pid,
        ppid: Number(o.ParentProcessId) || 0,
        name: String(o.Name ?? ''),
        cmd: String(o.CommandLine ?? ''),
      },
    ];
  });
}

/** Salida de `ps -eo pid=,ppid=,comm=,args=` → ProcInfo. */
export function parsePsList(text: string): ProcInfo[] {
  return text.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) return [];
    return [{ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] ?? '', cmd: m[4] ?? '' }];
  });
}

/** Procesos node y PowerShell del sistema (solo lectura). */
export async function listProcesses(): Promise<ProcInfo[]> {
  if (process.platform === 'win32') {
    const ps = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const r = await run(
      ps,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='powershell.exe' OR Name='pwsh.exe'\" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
      ],
      20_000,
    );
    return r.ok ? parseWindowsList(r.out) : [];
  }
  const r = await run('ps', ['-eo', 'pid=,ppid=,comm=,args='], 10_000);
  return r.ok ? parsePsList(r.out) : [];
}

export interface CloseDeps {
  list: () => Promise<ProcInfo[]>;
  /** El `pa stop` de esa instalación (su carpeta y su .env). */
  stop: (node: string, repo: string) => Promise<void>;
  kill: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  exclude?: readonly number[];
  isOurs?: (repo: string) => boolean;
}

export interface CloseOutcome {
  found: number;
  stoppedClean: number;
  killed: number[];
}

/**
 * Cierra todas las Asistentas en marcha: cierre limpio por su propio `pa stop`, espera
 * hasta `waitMs` y cierra a la fuerza lo que quede (daemons, luego lanzadores).
 */
export async function closeAllInstances(deps: CloseDeps, waitMs = 20_000): Promise<CloseOutcome> {
  const first = asistentaInstances(await deps.list(), deps.exclude, deps.isOurs);
  const found = first.daemons.length;
  const repos = new Map<string, string>();
  for (const d of first.daemons) {
    const of = daemonOf(d);
    if (of?.repo && !repos.has(of.repo.toLowerCase())) repos.set(of.repo.toLowerCase(), of.node);
  }
  for (const [key, node] of repos) {
    const repo =
      first.daemons.map(daemonOf).find((o) => o?.repo.toLowerCase() === key)?.repo ?? key;
    await deps.stop(node, repo).catch(() => {});
  }
  const killed: number[] = [];
  let now = asistentaInstances(await deps.list(), deps.exclude, deps.isOurs);
  for (let waited = 0; now.daemons.length > 0 && waited < waitMs; waited += 500) {
    await deps.sleep(500);
    now = asistentaInstances(await deps.list(), deps.exclude, deps.isOurs);
  }
  const stoppedClean = found - now.daemons.length;
  for (const d of now.daemons) {
    try {
      deps.kill(d.pid);
      killed.push(d.pid);
    } catch {
      // Ya no estaba o no es nuestro: nada que hacer.
    }
  }
  // Un lanzador espera a su node: muerto el node, normalmente termina solo.
  if (now.daemons.length > 0) await deps.sleep(1_000);
  for (const l of asistentaInstances(await deps.list(), deps.exclude, deps.isOurs).launchers) {
    try {
      deps.kill(l.pid);
      killed.push(l.pid);
    } catch {
      // Igual que arriba.
    }
  }
  return { found, stoppedClean, killed };
}

/** Las dependencias reales: `pa stop` de cada instalación y `process.kill`. */
export function realCloseDeps(): CloseDeps {
  return {
    list: listProcesses,
    stop: async (node, repo) => {
      await run(node || process.execPath, [join(repo, 'dist', 'cli.js'), 'stop'], 45_000, repo);
    },
    kill: (pid) => process.kill(pid),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export function closeOutcomeText(o: CloseOutcome): string {
  if (o.found === 0 && o.killed.length === 0) return 'No había ninguna otra Asistenta en marcha.';
  const forced = o.killed.length;
  return `Asistentas en marcha: ${o.found}. Paradas bien: ${o.stoppedClean}.${forced ? ` Cerrados a la fuerza: ${forced} ${forced === 1 ? 'proceso' : 'procesos'} de Asistenta (ningún otro).` : ''}`;
}

// El instalador lo ejecuta suelto (node instancias.mjs cerrar) con el node viejo.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href && process.argv[2] === 'cerrar') {
  closeAllInstances(realCloseDeps()).then(
    (o) => process.stdout.write(`${closeOutcomeText(o)}\n`),
    () => {
      process.exitCode = 1;
    },
  );
}

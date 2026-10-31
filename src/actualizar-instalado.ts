/**
 * `pa autoupdate` en la copia instalada con el .exe (sin git): baja el instalador que GitHub
 * adjunta a cada versión (.github/workflows/instalador-windows.yml), comprueba su SHA-256 y lo
 * abre sin ventanas; conserva .env y datos. Solo con `pa autoupdate now`, nunca de forma periódica.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RELEASES_API = 'https://api.github.com/repos/nicogarrr/asistenta/releases/latest';
export const RELEASES_PAGE = 'https://github.com/nicogarrr/asistenta/releases';
export const SHA_ASSET = 'Asistenta-Instalador.sha256';
const EXE_ASSET = /^Asistenta-Instalador-[\w.-]+\.exe$/;
const MAX_EXE_BYTES = 400 * 1024 * 1024;
const MAX_SHA_BYTES = 4096;
/** Solo GitHub: la API, la página de descarga y donde GitHub guarda los ficheros. */
const HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const MANUAL = `descarga el instalador de ${RELEASES_PAGE} y ábrelo; tu .env y tus datos se quedan.`;

/** Instalada con el .exe: sin .git, y con el desinstalador y el Node propio al lado. */
export function isInstalledLayout(repo: string, exists = existsSync): boolean {
  return (
    !exists(join(repo, '.git')) &&
    exists(join(repo, '..', 'Uninstall.exe')) &&
    exists(join(repo, '..', 'node', 'node.exe'))
  );
}

function parseVersion(v: string): number[] | null {
  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** true solo si `latest` es una versión x.y.z mayor que `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

function allowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** La huella del .exe en el fichero .sha256 («<64 hex>  <nombre>»). */
export function shaFor(text: string, name: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *]?(\S+)$/i.exec(line.trim());
    if (m && m[2] === name) return (m[1] ?? '').toLowerCase();
  }
  return null;
}

export interface InstaladoDeps {
  fetch: typeof fetch;
  current: string;
  platform: NodeJS.Platform;
  tmpDir: string;
  launch: (exe: string, args: string[]) => void;
  out: (text: string) => void;
}

async function get(deps: InstaladoDeps, url: string, max: number, json = false): Promise<Buffer> {
  if (!allowed(url)) throw new Error('fuera de GitHub');
  const res = await deps.fetch(url, {
    headers: {
      'User-Agent': 'asistenta',
      ...(json ? { Accept: 'application/vnd.github+json' } : {}),
    },
    signal: AbortSignal.timeout(json ? 15_000 : 600_000),
  });
  if (res.url && !allowed(res.url)) throw new Error('redirigido fuera de GitHub');
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  if (Number(res.headers.get('content-length') ?? 0) > max) throw new Error('demasiado grande');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error('demasiado grande');
  return buf;
}

type Asset = { name?: unknown; browser_download_url?: unknown };

/** Busca la versión publicada más reciente y, si es nueva, instala su .exe encima. */
export async function instalarUltima(deps: InstaladoDeps): Promise<number> {
  if (deps.platform !== 'win32') {
    deps.out('La actualización con el instalador solo funciona en Windows.');
    return 2;
  }
  let rel: { tag_name?: unknown; assets?: Asset[] };
  try {
    rel = JSON.parse((await get(deps, RELEASES_API, 1024 * 1024, true)).toString('utf8'));
  } catch (err) {
    deps.out(
      (err as { status?: number }).status === 404
        ? `Todavía no hay ninguna versión publicada con instalador. Cuando la haya, ${MANUAL}`
        : `No he podido mirar si hay versión nueva (¿sin internet?). Prueba más tarde, o ${MANUAL}`,
    );
    return 1;
  }
  const tag = typeof rel.tag_name === 'string' ? rel.tag_name : '';
  if (!isNewer(tag, deps.current)) {
    deps.out(`Ya tienes la última versión (${deps.current}).`);
    return 0;
  }
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const url = (a?: Asset) =>
    typeof a?.browser_download_url === 'string' ? a.browser_download_url : '';
  const exe = assets.find((a) => typeof a.name === 'string' && EXE_ASSET.test(a.name));
  const sha = assets.find((a) => a.name === SHA_ASSET);
  const version = tag.replace(/^v/, '');
  if (!exe || !sha || !url(exe) || !url(sha)) {
    deps.out(
      `Hay una versión nueva (${version}), pero sin instalador adjunto. Para actualizar, ${MANUAL}`,
    );
    return 1;
  }
  const name = String(exe.name);
  let file: string;
  try {
    const expected = shaFor((await get(deps, url(sha), MAX_SHA_BYTES)).toString('utf8'), name);
    const buf = await get(deps, url(exe), MAX_EXE_BYTES);
    if (!expected || createHash('sha256').update(buf).digest('hex') !== expected) {
      deps.out(
        'El instalador descargado no coincide con su huella SHA-256: no lo uso. No he tocado nada.',
      );
      return 1;
    }
    mkdirSync(deps.tmpDir, { recursive: true });
    file = join(deps.tmpDir, name);
    writeFileSync(file, buf);
  } catch {
    deps.out(
      `No he podido descargar el instalador nuevo. No he tocado nada. Prueba más tarde, o ${MANUAL}`,
    );
    return 1;
  }
  deps.launch(file, ['/S']);
  deps.out(
    `Instalando la versión ${version} (tenías ${deps.current}). Asistenta se cierra un momento y vuelve sola; tu .env y tus datos se quedan.`,
  );
  return 0;
}

const STATUS = (v: string) =>
  `Asistenta instalada con el .exe (versión ${v}): no se actualiza sola. Para buscar una versión nueva e instalarla encima: pa autoupdate now (tu .env y tus datos se quedan).`;

/**
 * `pa autoupdate` en la copia instalada. Devuelve null con argumentos que no conoce,
 * para que autoupdate-cli.ts dé su ayuda de siempre.
 */
export async function instaladoAutoupdateCommand(
  args: string[],
  repo: string,
  deps: Partial<InstaladoDeps> = {},
): Promise<number | null> {
  const action = args[0] ?? 'status';
  if (args.length > 1 || !['status', 'now', 'off', 'on', 'aplicar'].includes(action)) return null;
  let current = deps.current;
  if (!current) {
    try {
      current = String(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version ?? '?');
    } catch {
      current = '?';
    }
  }
  const full: InstaladoDeps = {
    fetch: deps.fetch ?? globalThis.fetch,
    current,
    platform: deps.platform ?? process.platform,
    tmpDir: deps.tmpDir ?? join(tmpdir(), 'asistenta-actualizar'),
    launch:
      deps.launch ??
      ((exe, flags) =>
        spawn(exe, flags, { detached: true, stdio: 'ignore', windowsHide: true }).unref()),
    out: deps.out ?? ((t) => process.stdout.write(`${t}\n`)),
  };
  if (action === 'now') return instalarUltima(full);
  // `aplicar` lo lanza la autoactualización periódica: aquí nunca instala sin que lo pidas.
  full.out(STATUS(current));
  return 0;
}

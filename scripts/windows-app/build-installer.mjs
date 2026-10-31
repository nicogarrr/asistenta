// Instalador .exe de Asistenta para Windows: `npm run build` y `npm run build:instalador`
// (en Linux: apt-get install nsis). Mete un Node portable oficial (versión fija, SHA-256
// comprobado), dist/ y las dependencias de producción para Windows x64; todo en var/ (ignorado).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcons } from './icono.mjs';

export const NODE_VERSION = '24.22.2';
/** SHA-256 publicado en https://nodejs.org/dist/v24.22.2/SHASUMS256.txt */
export const NODE_SHA256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2';
export const nodeZipName = (v = NODE_VERSION) => `node-v${v}-win-x64.zip`;
export const nodeZipUrl = (v = NODE_VERSION) => `https://nodejs.org/dist/v${v}/${nodeZipName(v)}`;

/** Lo que va a %LOCALAPPDATA%\Asistenta\app. Nunca .env ni datos: esos son del usuario. */
const APP_DIRS = ['dist', 'deploy', 'config', 'browserd', 'scripts', 'evolve'];
const APP_FILES = ['.env.example', 'package.json', 'package-lock.json', 'README.md'];
export const APP_ITEMS = [
  ...APP_DIRS.map((path) => ({ path, dir: true })),
  ...APP_FILES.map((path) => ({ path, dir: false })),
];

/** Dependencias de producción para Windows x64 aunque se construya en Linux. */
export const PROD_INSTALL_ARGS = [
  'ci',
  '--omit=dev',
  '--no-audit',
  '--no-fund',
  '--os=win32',
  '--cpu=x64',
];
export const PROD_INSTALL_ENV = {
  npm_config_platform: 'win32',
  npm_config_arch: 'x64',
  ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip',
};

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Baja el zip de Node (o usa el de la caché) y comprueba su SHA-256 antes de guardarlo. */
export async function nodeZip({
  fetchFn,
  cacheDir,
  version = NODE_VERSION,
  expected = NODE_SHA256,
}) {
  const file = join(cacheDir, nodeZipName(version));
  if (existsSync(file) && sha256(readFileSync(file)) === expected) return file;
  const res = await fetchFn(nodeZipUrl(version));
  if (!res.ok)
    throw new Error(`No he podido bajar Node ${version} (HTTP ${res.status}). Mira la conexión.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== expected)
    throw new Error(`El Node descargado no coincide con el oficial (SHA-256 distinto). No lo uso.`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, buf);
  return file;
}

/** Qué se copia a la carpeta de preparación; avisa si falta compilar. */
export function stagePlan(root, stage) {
  if (!existsSync(join(root, 'dist', 'cli.js')))
    throw new Error('Falta dist/cli.js: compila antes con «npm run build».');
  return APP_ITEMS.filter((i) => existsSync(join(root, i.path))).map((i) => ({
    from: join(root, i.path),
    to: join(stage, 'app', i.path),
  }));
}

const win = (p) => p.replaceAll('/', '\\');

/** Órdenes NSIS que quitan el programa viejo de app\ sin tocar .env ni datos. */
export function removeAppLines() {
  return APP_ITEMS.map((i) =>
    i.dir
      ? `  RMDir /r "$INSTDIR\\app\\${win(i.path)}"`
      : `  Delete "$INSTDIR\\app\\${win(i.path)}"`,
  ).join('\n');
}

/** Rellena la plantilla .nsi; falla si queda algún hueco @@X@@ sin rellenar. */
export function renderNsi(template, vars) {
  const all = { REMOVE_APP: removeAppLines(), ...vars };
  const out = template.replace(/@@([A-Z_]+)@@/g, (m, k) => (k in all ? String(all[k]) : m));
  const left = out.match(/@@[A-Z_]+@@/);
  if (left) throw new Error(`Plantilla del instalador: falta el valor ${left[0]}`);
  return out;
}

export function sizeKb(dir) {
  const r = spawnSync('du', ['-sk', dir], { encoding: 'utf8' });
  return Number.parseInt(r.stdout, 10) || 0;
}

export async function build(d) {
  const root = d.root;
  const stage = join(root, 'var', 'instalador');
  const plan = stagePlan(root, stage);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  d.say(`… Preparando Asistenta ${version} en var/instalador`);
  rmSync(join(stage, 'app'), { recursive: true, force: true });
  rmSync(join(stage, 'node'), { recursive: true, force: true });
  for (const p of plan) cpSync(p.from, p.to, { recursive: true });
  d.say('… Dependencias de producción para Windows x64');
  if (d.run('npm', PROD_INSTALL_ARGS, { cwd: join(stage, 'app'), env: PROD_INSTALL_ENV }) !== 0)
    throw new Error('npm ci (producción, Windows) ha fallado: mira el mensaje de arriba.');
  const zip = await nodeZip({ fetchFn: d.fetch, cacheDir: join(root, 'var', 'cache') });
  if (d.run('unzip', ['-q', zip, '-d', stage], {}) !== 0)
    throw new Error('No he podido descomprimir Node (¿falta unzip?).');
  cpSync(join(stage, `node-v${NODE_VERSION}-win-x64`), join(stage, 'node'), { recursive: true });
  rmSync(join(stage, `node-v${NODE_VERSION}-win-x64`), { recursive: true, force: true });
  const sharp = d.sharp ?? (await import('sharp')).default;
  await makeIcons(join(d.here, 'asistenta.png'), stage, sharp);
  const outFile = join(root, 'var', `Asistenta-Instalador-${version}.exe`);
  const nsi = renderNsi(readFileSync(join(d.here, 'asistenta.nsi'), 'utf8'), {
    VERSION: version,
    STAGE: stage,
    OUTFILE: outFile,
    SIZE_KB: sizeKb(stage),
  });
  writeFileSync(join(stage, 'asistenta.nsi'), nsi);
  if (
    d.run(
      'makensis',
      ['-NOCONFIG', '-INPUTCHARSET', 'UTF8', '-V2', join(stage, 'asistenta.nsi')],
      {},
    ) !== 0
  )
    throw new Error('makensis ha fallado (en Linux: sudo apt-get install nsis).');
  d.say(`✓ Instalador listo: ${outFile} (${Math.round(statSync(outFile).size / 1048576)} MB)`);
  return outFile;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const here = dirname(fileURLToPath(import.meta.url));
  try {
    await build({
      root: resolve(here, '..', '..'),
      here,
      say: (s) => console.log(s),
      fetch: (u) => fetch(u, { signal: AbortSignal.timeout(300_000) }),
      run: (cmd, args, o) =>
        spawnSync(cmd, args, { stdio: 'inherit', cwd: o.cwd, env: { ...process.env, ...o.env } })
          .status ?? 1,
    });
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

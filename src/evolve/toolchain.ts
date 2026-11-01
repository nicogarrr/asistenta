import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/**
 * Huella de lo que lanza la medición fuera de la copia: el `node`, `npx` y `npm` que encuentra el
 * PATH (en orden), el binario de Node, el paquete npm de esa instalación (su código y su config
 * propia, `npmrc`) y la config global `<prefijo>/etc/npmrc`. En un Node del usuario (nvm en
 * Linux/mac) todo eso se puede escribir sin permisos: un `node-options` en el npmrc propio de
 * npm cargaba código en el `npx vitest` de la medición (comprobado con npm real en una copia
 * de Node, 31 oct), y un `npx` puesto antes en el PATH sustituiría a la suite entera.
 * Solo fechas, tamaños e inodos (como depsFingerprint): un cambio se ve, aunque se devuelva el texto.
 */
export function toolchainFingerprint(
  opts: { execPath?: string; pathEnv?: string; platform?: NodeJS.Platform } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const win = platform === 'win32';
  const execPath = opts.execPath ?? process.execPath;
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? process.env.Path ?? '';
  const h = createHash('sha256');
  let budget = 50_000;
  const stat = (p: string): void => {
    let line = '-';
    try {
      const st = lstatSync(p);
      const link = st.isSymbolicLink() ? readlinkSync(p) : '';
      line = `${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}\0${link}`;
    } catch {}
    h.update(`${p}\0${line}\n`);
  };
  // npx lanza vitest con el shell que encuentra el PATH (`sh -c vitest`, en Windows cmd): un
  // `sh` falso antes en el PATH corría en la medición (comprobado con npm real, 31 oct).
  // Y `git`: el bucle mira con él si el kernel sigue limpio y en su commit; un `git` falso antes
  // en el PATH contestaba «limpio» con el árbol sucio (comprobado con git real, 31 oct).
  // Y las herramientas con las que se buscan y se matan los procesos del intento (ps, lsof;
  // en Windows PowerShell, taskkill, netstat): un `ps` falso antes en el PATH dejaba de ver
  // un proceso vivo, y así sobrevivía a la recogida (comprobado con ps real, 31 oct).
  const names = win
    ? [
        'node.exe',
        'node.cmd',
        'npx.cmd',
        'npx.ps1',
        'npx.exe',
        'npm.cmd',
        'npm.ps1',
        'npm.exe',
        'cmd.exe',
        'git.exe',
        'git.cmd',
        'powershell.exe',
        'taskkill.exe',
        'netstat.exe',
      ]
    : ['node', 'npx', 'npm', 'sh', 'git', 'ps', 'lsof'];
  for (const dir of pathEnv.split(win ? ';' : delimiter).slice(0, 100)) {
    if (!dir) continue;
    // Solo los que existen: un fichero nuevo antes en el PATH añade una línea.
    for (const n of names) if (existsSync(join(dir, n))) stat(join(dir, n));
  }
  stat(execPath);
  const prefix = win ? dirname(execPath) : dirname(dirname(execPath));
  const etc = join(prefix, 'etc', 'npmrc');
  h.update(`${etc}\0`);
  h.update(existsSync(etc) && statSync(etc).isFile() ? readFileSync(etc) : '-');
  h.update('\n');
  const npmDir = win
    ? join(prefix, 'node_modules', 'npm')
    : join(prefix, 'lib', 'node_modules', 'npm');
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of entries) {
      if (--budget < 0) return;
      const p = join(dir, n);
      stat(p);
      try {
        if (lstatSync(p).isDirectory()) walk(p);
      } catch {}
    }
  };
  stat(npmDir);
  walk(npmDir);
  return h.digest('hex');
}

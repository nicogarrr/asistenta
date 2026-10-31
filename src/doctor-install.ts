/**
 * `pa doctor`: dos cosas de la instalación que en Windows rompen sin avisar.
 * - La carpeta dentro de OneDrive: OneDrive bloquea archivos mientras sincroniza y
 *   `npm ci`, la compilación o la autoactualización fallan con EPERM/EBUSY.
 * - Node más viejo que 24: Asistenta no está hecha para él.
 * Misma regla que scripts/instalar.mjs (que corre antes de compilar y no puede importar esto).
 */
import { REPO_DIR } from './paths.js';

export const NODE_MIN = 24;

export function enOneDrive(dir: string | undefined, env: NodeJS.ProcessEnv = {}): boolean {
  const norm = (p: string | undefined): string =>
    String(p ?? '')
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase();
  const d = norm(dir);
  if (!d) return false;
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const r = norm(env[k]);
    if (r && (d === r || d.startsWith(`${r}\\`))) return true;
  }
  return /\\onedrive( - [^\\]+)?(\\|$)/.test(d);
}

/** Carpeta del sistema (Archivos de programa, Windows): sin administrador no se puede escribir. */
export function enCarpetaSistema(dir: string | undefined, env: NodeJS.ProcessEnv = {}): boolean {
  const norm = (p: string | undefined): string =>
    String(p ?? '')
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase();
  const d = norm(dir);
  if (!d) return false;
  for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'SystemRoot', 'windir']) {
    const r = norm(env[k]);
    if (r && (d === r || d.startsWith(`${r}\\`))) return true;
  }
  return /^[a-z]:\\(program files( \(x86\))?|windows)(\\|$)/.test(d);
}

export function nodeMajor(version: string): number {
  const n = Number(String(version).replace(/^v/, '').split('.')[0]);
  return Number.isInteger(n) ? n : 0;
}

export interface InstallDoctorInput {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

/** Líneas «node» y «carpeta» de `pa doctor`. */
export function installDoctorLines(input: InstallDoctorInput = {}): string[] {
  const dir = input.dir ?? REPO_DIR;
  const env = input.env ?? process.env;
  const v = input.nodeVersion ?? process.version;
  const node =
    nodeMajor(v) >= NODE_MIN
      ? `node            ${v}`
      : `node            ${v} — DEMASIADO VIEJO: hace falta Node ${NODE_MIN} o más nuevo (gratis en https://nodejs.org); instálalo y vuelve a abrir instalar.bat`;
  const carpeta = enCarpetaSistema(dir, env)
    ? `carpeta         ${dir} — es una carpeta del sistema: sin permisos de administrador Windows no deja escribir ahí y fallan la instalación y las actualizaciones. Muévela a C:\\Asistenta y vuelve a abrir instalar.bat`
    : enOneDrive(dir, env)
      ? `carpeta         ${dir} — está dentro de OneDrive: bloquea archivos al sincronizar y rompe la instalación y las actualizaciones. Muévela a C:\\Asistenta y vuelve a abrir instalar.bat`
      : `carpeta         ${dir}`;
  return [node, carpeta];
}

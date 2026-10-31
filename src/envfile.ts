/**
 * Optional .env, loaded from the working directory (the repo root under
 * `npm start`) and then from the install folder, with Node's own parser: KEY=VALUE, optional `export`, quotes
 * and comments. Variables already present in the process environment always
 * win (same rule as loadEnvFile), and a malformed file warns on stderr
 * (in plain Spanish) instead of killing startup.
 *
 * THIS MODULE MUST BE THE FIRST IMPORT OF THE ENTRYPOINT. paths.ts and
 * log.ts capture process.env (PA_STATE_DIR, PA_LOG_LEVEL) at module
 * evaluation time, so any import order that reaches them before this module
 * leaves the process with split configuration: loadConfig would see the .env
 * while paths/log keep the ambient environment.
 *
 * Windows: el Bloc de notas y PowerShell 5 guardan a menudo con BOM (UTF-8) o
 * en UTF-16. Con loadEnvFile la primera variable quedaba como «\uFEFFCLAVE» y
 * se perdía sin aviso (o el archivo entero, en UTF-16). Aquí se quita el BOM.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { envFileText } from './env-text.js';

export { envFileText };

/** Aviso en castellano llano; el detalle técnico se queda en el código de error. */
export function envReadWarning(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM')
    return 'Aviso: no tengo permiso para leer el archivo .env. Arranco sin él.\n';
  if (code === 'EBUSY')
    return 'Aviso: el archivo .env está bloqueado por otro programa. Ciérralo y vuelve a arrancar; de momento sigo sin él.\n';
  if (code === 'EISDIR') return 'Aviso: «.env» es una carpeta, no un archivo. Arranco sin él.\n';
  if (code) return `Aviso: no pude leer el archivo .env (${code}). Arranco sin él.\n`;
  return 'Aviso: no entiendo el archivo .env (cada línea debe ser CLAVE=valor). Arranco sin él.\n';
}

/** Carga `file` en `env` sin pisar lo que ya hay. */
export function loadDotEnv(file = '.env', env: NodeJS.ProcessEnv = process.env): void {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(envReadWarning(err));
    }
    return;
  }
  try {
    for (const [key, value] of Object.entries(parseEnv(envFileText(buf)))) {
      if (env[key] === undefined) env[key] = value;
    }
  } catch {
    process.stderr.write(envReadWarning(undefined));
  }
}

/**
 * Los .env que se leen: el de la carpeta actual y el de la instalación (junto a
 * src/ y dist/). Antes solo el de la carpeta actual: `pa doctor` o `pa vault`
 * lanzados desde otra carpeta no veían el token del bot ni el del panel y
 * decían «falta» aunque estuvieran puestos. El de la carpeta actual gana.
 */
export function dotEnvFiles(
  cwd: string = process.cwd(),
  moduleUrl: string = import.meta.url,
): string[] {
  const here = resolve(cwd, '.env');
  const install = join(fileURLToPath(new URL('..', moduleUrl)), '.env');
  return here === resolve(install) ? [here] : [here, install];
}

for (const file of dotEnvFiles()) loadDotEnv(file);

/**
 * Optional .env, loaded from the working directory (the repo root under
 * `npm start`) with Node's own parser: KEY=VALUE, optional `export`, quotes
 * and comments. Variables already present in the process environment always
 * win (same rule as loadEnvFile), and a malformed file warns on stderr
 * instead of killing startup.
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
import { parseEnv } from 'node:util';

/** Texto de un .env tal como lo guarda Windows: sin BOM y, si viene en UTF-16, decodificado. */
export function envFileText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2));
    le.swap16();
    return le.toString('utf16le');
  }
  return buf.toString('utf8');
}

/** Carga `file` en `env` sin pisar lo que ya hay. */
export function loadDotEnv(file = '.env', env: NodeJS.ProcessEnv = process.env): void {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `.env could not be read: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return;
  }
  try {
    for (const [key, value] of Object.entries(parseEnv(envFileText(buf)))) {
      if (env[key] === undefined) env[key] = value;
    }
  } catch (err) {
    process.stderr.write(
      `.env could not be read: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

loadDotEnv();

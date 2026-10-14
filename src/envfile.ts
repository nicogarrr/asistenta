/**
 * Optional .env, loaded from the working directory (the repo root under
 * `npm start`) with Node's own parser: KEY=VALUE, optional `export`, quotes
 * and comments. Variables already present in the process environment always
 * win (verified against Node 22.23: loadEnvFile never overrides), and a
 * malformed file warns on stderr instead of killing startup.
 *
 * THIS MODULE MUST BE THE FIRST IMPORT OF THE ENTRYPOINT. paths.ts and
 * log.ts capture process.env (PA_STATE_DIR, PA_LOG_LEVEL) at module
 * evaluation time, so any import order that reaches them before this module
 * leaves the process with split configuration: loadConfig would see the .env
 * while paths/log keep the ambient environment.
 *
 * loadEnvFile exists since Node 20.12; asistenta already requires >= 22.5
 * (node:sqlite), so the optional-call guard only appeases older @types/node.
 */
try {
  (process as NodeJS.Process & { loadEnvFile?: (path?: string) => void }).loadEnvFile?.();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    process.stderr.write(`.env could not be read: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export {};

/**
 * Un ciclo manual del vigilante de precios (node dist/watch/pricewatch-cli.js), útil para
 * depurar. En uso normal NO hace falta: Asistenta lo ejecuta solo en bucle (pricewatch-loop.ts).
 * Config y variables: ver pricewatch-runner.ts.
 */

import { join } from 'node:path';
import { STATE_DIR } from '../paths.js';
import { realDeps, runCycle } from './pricewatch-runner.js';

const configPath = process.env.PRICEWATCH_CONFIG ?? join(STATE_DIR, 'pricewatch.json');
const log = {
  info: (msg: string, f?: Record<string, unknown>) =>
    process.stdout.write(`${msg} ${f ? JSON.stringify(f) : ''}\n`),
  warn: (msg: string, f?: Record<string, unknown>) =>
    process.stdout.write(`AVISO ${msg} ${f ? JSON.stringify(f) : ''}\n`),
};
const r = await runCycle(realDeps(configPath, join(STATE_DIR, 'pricewatch.sqlite'), log, true));
process.stdout.write(
  r.ran
    ? `ciclo hecho ${JSON.stringify({ ...r.scan, candidates: r.scan?.candidates.length })}\n`
    : 'pricewatch desactivado (enabled=false): sin peticiones\n',
);

/**
 * `pa precio`: el vigilante de precios a mano (antes era un script suelto,
 * node dist/watch/pricewatch-cli.js). En uso normal NO hace falta: el daemon lo ejecuta
 * solo en bucle (pricewatch-loop.ts). Config y variables: ver pricewatch-runner.ts.
 *
 *   pa precio                 un ciclo ahora; los avisos salen por pantalla, no por Telegram
 *   pa precio comprobar       valida pricewatch.json y dice qué productos vigila
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../paths.js';
import { parseConfig, STORES } from './pricewatch.js';
import { type CycleResult, realDeps, runCycle } from './pricewatch-runner.js';

export interface PricewatchCommandIo {
  configPath?: string;
  dbPath?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** Un ciclo real; inyectable en tests. */
  runOnce?: (configPath: string, dbPath: string) => Promise<CycleResult>;
}

const USAGE = 'uso: pa precio [comprobar]\n';

function defaultRun(configPath: string, dbPath: string): Promise<CycleResult> {
  const log = {
    info: (msg: string, f?: Record<string, unknown>) =>
      process.stdout.write(`${msg} ${f ? JSON.stringify(f) : ''}\n`),
    warn: (msg: string, f?: Record<string, unknown>) =>
      process.stdout.write(`AVISO ${msg} ${f ? JSON.stringify(f) : ''}\n`),
  };
  return runCycle(realDeps(configPath, dbPath, log, true));
}

export async function pricewatchCommand(
  args: string[],
  io: PricewatchCommandIo = {},
): Promise<number> {
  const configPath =
    io.configPath ?? process.env.PRICEWATCH_CONFIG ?? join(STATE_DIR, 'pricewatch.json');
  const dbPath = io.dbPath ?? join(STATE_DIR, 'pricewatch.sqlite');
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const sub = (args[0] ?? '').toLowerCase();
  if (sub !== '' && sub !== 'comprobar' && sub !== 'check') {
    err(USAGE);
    return 2;
  }
  if (!existsSync(configPath)) {
    err(
      `No existe ${configPath}: el vigilante de precios está apagado. Créalo con {"enabled": true, "products": [...]} (ver src/watch/pricewatch-runner.ts). Para vigilar un enlace concreto basta con /vigila en Telegram.\n`,
    );
    return 1;
  }
  let cfg: ReturnType<typeof parseConfig>;
  try {
    cfg = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
  } catch (e) {
    err(`${configPath} no es válido: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (sub === 'comprobar' || sub === 'check') {
    const lines = cfg.products.map((p) => {
      const stores = Object.keys(p.urls)
        .map((s) => STORES[s as keyof typeof STORES]?.name ?? s)
        .join(', ');
      return `- ${p.label ?? p.name}: ${stores || 'sin tiendas'}`;
    });
    out(
      `Vigilante de precios ${cfg.enabled ? 'ACTIVADO' : 'desactivado (enabled=false)'}, ${cfg.products.length} producto(s), bajada mínima ${cfg.minDropPct} %.\n${lines.join('\n')}${lines.length ? '\n' : ''}`,
    );
    return 0;
  }
  const r = await (io.runOnce ?? defaultRun)(configPath, dbPath);
  out(
    r.ran
      ? `ciclo hecho ${JSON.stringify({ ...r.scan, candidates: r.scan?.candidates.length })}\n`
      : 'pricewatch desactivado (enabled=false): sin peticiones\n',
  );
  return 0;
}

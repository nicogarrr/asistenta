/**
 * Bucle interno del vigilante de precios: arranca con Asistenta, relee la config en cada ciclo
 * (se puede activar sin reiniciar) y no hace ninguna petición mientras enabled=false.
 */

import { join } from 'node:path';
import {
  type CycleDeps,
  type CycleLog,
  cycleMinutesOf,
  realDeps,
  runCycle,
} from './pricewatch-runner.js';

export const FIRST_DELAY_MS = 60_000;

export interface LoopHandle {
  stop: () => void;
}

export function startPricewatchLoop(opts: {
  configPath: string;
  stateDir: string;
  log: CycleLog;
  deps?: CycleDeps;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void; clear: () => void };
  firstDelayMs?: number;
  mainBotToken?: string;
}): LoopHandle {
  const deps =
    opts.deps ??
    realDeps(
      opts.configPath,
      join(opts.stateDir, 'pricewatch.sqlite'),
      opts.log,
      false,
      opts.mainBotToken,
    );
  const setTimer =
    opts.setTimer ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return { clear: () => clearTimeout(t) };
    });
  let stopped = false;
  let running = false;
  let timer: { clear: () => void } | null = null;
  let loggedMissing = false;

  const schedule = (ms: number): void => {
    if (stopped) return;
    timer = setTimer(() => void tick(), ms);
  };

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    let next = 30 * 60_000;
    try {
      const r = await runCycle(deps);
      next = r.cycleMinutes * 60_000;
      loggedMissing = false;
    } catch (err) {
      const missing = (err as { code?: string }).code === 'ENOENT';
      if (!missing || !loggedMissing) {
        opts.log.warn('pricewatch: ciclo fallido', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      loggedMissing = missing;
      try {
        next = cycleMinutesOf(deps.readConfig()) * 60_000;
      } catch {
        next = 30 * 60_000;
      }
    } finally {
      running = false;
    }
    schedule(next);
  };

  schedule(opts.firstDelayMs ?? FIRST_DELAY_MS);
  return {
    stop: () => {
      stopped = true;
      timer?.clear();
    },
  };
}

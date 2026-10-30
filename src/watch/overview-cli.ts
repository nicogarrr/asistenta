import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../db.js';
import { paths } from '../paths.js';
import {
  formatOverview,
  forScope,
  fromOjo,
  fromPageWatches,
  fromPriceConfig,
  fromRoutines,
  fromTriggers,
  type OjoState,
  type OverviewEntry,
} from './overview.js';
import { PageWatchStore } from './pages.js';
import { parseConfig, type WatchConfig } from './pricewatch.js';

export interface OverviewSources {
  stateDir: string;
  agentDb: string;
  priceConfig: string;
}

export function defaultSources(env: NodeJS.ProcessEnv = process.env): OverviewSources {
  return {
    stateDir: paths.state,
    agentDb: paths.db,
    priceConfig: env.PRICEWATCH_CONFIG ?? join(paths.state, 'pricewatch.json'),
  };
}

/**
 * Interruptores del ojo leídos SIN escribir (los getters de vigilante/ojo-* crean tablas).
 * Mismos valores por defecto: el general encendido salvo 'off'; pantalla y descargas solo con 'on'.
 */
export function readOjoState(db: DatabaseSync): OjoState {
  const has = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vigilante_settings'")
    .get();
  const get = (key: string): string | undefined =>
    has
      ? (
          db.prepare('SELECT value FROM vigilante_settings WHERE key = ?').get(key) as
            | { value: string }
            | undefined
        )?.value
      : undefined;
  return {
    attention: get('enabled') !== 'off',
    screen: get('screen_enabled') === 'on',
    downloads: get('downloads_enabled') === 'on',
  };
}

/** Lee todas las listas. Una fuente que falla se informa y no tumba las demás. */
export function collectWatches(src: OverviewSources): {
  entries: OverviewEntry[];
  errors: string[];
} {
  const entries: OverviewEntry[] = [];
  const errors: string[] = [];
  const memFile = join(src.stateDir, 'memory.db');
  if (existsSync(memFile)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(memFile);
      db.exec('PRAGMA busy_timeout = 5000');
      entries.push(...fromPageWatches(new PageWatchStore(db).listAll()));
    } catch (err) {
      errors.push(`páginas: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      if (db) {
        entries.push(...fromOjo(readOjoState(db)));
      }
    } catch (err) {
      errors.push(`ojo: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      db?.close();
    }
  }
  if (existsSync(src.priceConfig)) {
    try {
      const cfg: WatchConfig = parseConfig(JSON.parse(readFileSync(src.priceConfig, 'utf8')));
      entries.push(...fromPriceConfig(cfg));
    } catch (err) {
      errors.push(`pricewatch.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (existsSync(src.agentDb)) {
    let store: Store | undefined;
    try {
      store = new Store(src.agentDb);
      entries.push(...fromRoutines(store.listRoutines()), ...fromTriggers(store.listTriggers()));
    } catch (err) {
      errors.push(`rutinas: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      store?.close();
    }
  }
  return { entries, errors };
}

const USAGE = 'uso: pa vigilancias [--chat <scope>] [--json]\n';

/** `pa vigilancias`: qué está vigilando Asistenta, de todas las listas a la vez (solo lectura). */
export async function vigilanciasCommand(
  args: readonly string[],
  src: OverviewSources = defaultSources(),
  out: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> {
  let json = false;
  let chat: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--chat' && args[i + 1]) chat = args[++i];
    else {
      process.stderr.write(USAGE);
      return 2;
    }
  }
  const { entries, errors } = collectWatches(src);
  const shown = forScope(entries, chat);
  if (json) out(`${JSON.stringify({ entries: shown, errors }, null, 2)}\n`);
  else {
    out(`${formatOverview(shown)}\n`);
    for (const e of errors) out(`(no se pudo leer ${e})\n`);
  }
  return errors.length && !shown.length ? 1 : 0;
}

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrarMemoriaACarpeta } from './memory/migrar-carpeta.js';
import { llevarMemoriaABoveda } from './memory/obsidian.js';

/**
 * Every mutable path the agent owns lives under the state dir, never in the repo.
 *
 * The repo is meant to be committed and shareable; logs, the database, the vault
 * and session transcripts are per-machine and per-user secrets. Keeping them in
 * one dir makes "wipe this machine" a single delete and makes backup trivial.
 */
export const STATE_DIR =
  process.env.PA_STATE_DIR || join(homedir(), '.local', 'share', 'personal-agent');
/**
 * Raíz del repo a partir de la URL del módulo. `URL.pathname` deja los caracteres
 * codificados (`Mis%20proyectos`, `Nicol%C3%A1s`): con un espacio o una tilde en la
 * ruta, `pa doctor` buscaba package.json en una carpeta que no existe.
 */
export function repoDirFrom(moduleUrl: string): string {
  return fileURLToPath(new URL('..', moduleUrl)).replace(/[\\/]$/, '');
}
export const REPO_DIR = repoDirFrom(import.meta.url);

export interface EleccionBoveda {
  /** Carpeta de memoria (perfil, episodios, procedimientos, notas, índice). */
  memoria: string;
  /** Raíz de la bóveda de Obsidian, para seguir enlaces (la propia memoria si no hay otra). */
  boveda: string;
  /** Lo que pedía PA_OBSIDIAN_VAULT (null si no está puesto). */
  pedida: string | null;
  /** Por qué no se usa la carpeta pedida (null si se usa o no se pidió). */
  motivo: string | null;
}

/** `%USERPROFILE%\…`, `~/…` y comillas, como lo escribiría Nico en el .env. */
function expandirRuta(ruta: string, home: string, env: NodeJS.ProcessEnv): string {
  let r = ruta.trim().replace(/^["']|["']$/g, '');
  r = r.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k: string) => {
    const v = env[k] ?? (k.toUpperCase() === 'USERPROFILE' ? home : undefined);
    return v ?? m;
  });
  if (r === '~' || r.startsWith('~/') || r.startsWith('~\\')) r = join(home, r.slice(1));
  return r;
}

/**
 * Dónde vive la memoria. Por defecto `<estado>/memoria`. Con
 * `PA_OBSIDIAN_VAULT=<carpeta de una bóveda que ya usas>` (por ejemplo la de
 * iCloud Drive para leerla en el iPhone) va a `<bóveda>/Asistenta`, y los enlaces
 * se buscan en toda la bóveda. Una ruta que no es completa o que no existe no se
 * usa (una errata no puede dejar la memoria en una carpeta nueva y vacía).
 */
export function elegirBoveda(
  env: NodeJS.ProcessEnv,
  stateDir: string,
  home: string = homedir(),
  esCarpeta: (p: string) => boolean = (p) => {
    try {
      return existsSync(p) && statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
): EleccionBoveda {
  const porDefecto = join(stateDir, 'memoria');
  const bruta = env.PA_OBSIDIAN_VAULT?.trim();
  if (!bruta) return { memoria: porDefecto, boveda: porDefecto, pedida: null, motivo: null };
  const pedida = expandirRuta(bruta, home, env);
  const fuera = (motivo: string): EleccionBoveda => ({
    memoria: porDefecto,
    boveda: porDefecto,
    pedida,
    motivo,
  });
  if (!win32.isAbsolute(pedida) && !posix.isAbsolute(pedida)) {
    return fuera('no es una ruta completa (tiene que empezar por C:\\ o similar)');
  }
  if (!esCarpeta(pedida)) return fuera('esa carpeta no existe en este PC');
  return { memoria: join(pedida, 'Asistenta'), boveda: pedida, pedida, motivo: null };
}

/** La bóveda elegida al arrancar (PA_OBSIDIAN_VAULT). */
export const BOVEDA = elegirBoveda(process.env, STATE_DIR);

/** Carpeta de memoria legible: perfil, episodios, procedimientos, notas, índice. */
const MEMORIA_DIR = BOVEDA.memoria;

export const paths = {
  state: STATE_DIR,
  db: join(STATE_DIR, 'agent.db'),
  vault: join(STATE_DIR, 'vault.enc'),
  log: join(STATE_DIR, 'log'),
  /** Metricas del enrutador web (JSONL, una linea por intento). */
  webMetrics: join(STATE_DIR, 'log', 'web-metrics.jsonl'),
  screenshots: join(STATE_DIR, 'screenshots'),
  sessions: join(STATE_DIR, 'sessions'),
  pidFile: join(STATE_DIR, 'agent.pid'),
  heartbeat: join(STATE_DIR, 'agent.heartbeat'),
  /**
   * One Playwright profile per chat, so a logged-in session survives a daemon
   * restart. Isolated per chat because two chats must never share cookies: that
   * is how one user's session leaks into another's browser view.
   */
  browser: join(STATE_DIR, 'browser'),
  /** Long-term memory markdown, one file per scope. */
  memory: join(MEMORIA_DIR, 'notas'),
  /**
   * La carpeta de memoria legible (src/memory/carpeta.ts): perfil, episodios
   * diarios, procedimientos, notas e índice, en Markdown que Nico abre a mano.
   * Antes estaba repartida en memory/, snapshot/ y skills/; ensureDirs() la
   * migra una vez (src/memory/migrar-carpeta.ts).
   */
  memoria: MEMORIA_DIR,
  /** Raíz de la bóveda de Obsidian (PA_OBSIDIAN_VAULT) o la propia carpeta de memoria. */
  boveda: BOVEDA.boveda,
  /** Donde vive PERFIL.md (MemorySnapshot). */
  perfil: MEMORIA_DIR,
  /** Habilidades aprendidas (SkillStore): una carpeta por cómo-se-hace. */
  procedimientos: join(MEMORIA_DIR, 'procedimientos'),
  /** Document memory: the FTS5 index plus the extracted-text mirror. */
  docs: join(STATE_DIR, 'docs'),
  /** Voice scratch files (decoded pcm, synthesized wav, opus). */
  voice: join(STATE_DIR, 'voice'),
  /**
   * Local model cache for speech-to-text. Kept inside the state dir on purpose:
   * a wiped machine must not leave a whisper model behind, and it must not be
   * committed with the repo.
   */
  models: join(STATE_DIR, 'models'),
} as const;

export function ensureDirs(): void {
  // Con PA_OBSIDIAN_VAULT, la primera vez se copia la memoria de siempre a la
  // bóveda (comprobada byte a byte); la original se queda como copia.
  if (BOVEDA.memoria !== join(STATE_DIR, 'memoria')) {
    try {
      llevarMemoriaABoveda(join(STATE_DIR, 'memoria'), BOVEDA.memoria);
    } catch {
      // Nunca bloquea el arranque: la memoria nueva empieza en la bóveda.
    }
  }
  // Primero la migración (una vez): mueve memory/, snapshot/PERFIL.md y skills/
  // a la carpeta memoria/ con copia de seguridad, antes de que nada los lea.
  try {
    const r = migrarMemoriaACarpeta(paths.state, paths.memoria);
    if (r.errores.length) {
      mkdirSync(paths.memoria, { recursive: true, mode: 0o700 });
      writeFileSync(join(paths.memoria, 'migracion-error.txt'), `${r.errores.join('\n')}\n`);
    }
  } catch {
    // Nunca bloquea el arranque; el siguiente arranque lo reintenta.
  }
  for (const dir of [
    paths.state,
    paths.log,
    paths.screenshots,
    paths.sessions,
    paths.browser,
    paths.memoria,
    join(paths.memoria, 'episodios'),
    paths.procedimientos,
    paths.memory,
    paths.voice,
    paths.models,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

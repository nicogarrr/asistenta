import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  memory: join(STATE_DIR, 'memory'),
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
  for (const dir of [
    paths.state,
    paths.log,
    paths.screenshots,
    paths.sessions,
    paths.browser,
    paths.memory,
    paths.voice,
    paths.models,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

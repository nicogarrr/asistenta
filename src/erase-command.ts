import type { DatabaseSync } from 'node:sqlite';
import { eraseScope } from './maintenance.js';

/**
 * /borrar_chat: borrar la memoria, el historial y el perfil de un chat es
 * irreversible, así que nunca ocurre con un solo mensaje. El comando deja una
 * petición pendiente y solo el mensaje siguiente con la palabra exacta
 * {@link ERASE_WORD}, dentro de {@link ERASE_TTL_MS}, la ejecuta. Cualquier
 * otro mensaje la cancela y, pasado el plazo, se olvida sin borrar nada.
 */
export const ERASE_WORD = 'BORRAR';
export const ERASE_TTL_MS = 120_000;

export const ERASE_PROMPT =
  '⚠️ Esto borra la memoria, el historial de conversaciones, el perfil y los seguimientos pendientes de este chat (todos sus temas). Los objetivos aprobados se quedan. No se puede deshacer.\n' +
  `Escribe ${ERASE_WORD} (en mayúsculas) en los próximos 2 minutos para confirmar. Cualquier otro mensaje lo cancela.`;

export type EraseDecision = 'confirmed' | 'cancelled';

export class EraseConfirm {
  readonly #pending = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(ttlMs = ERASE_TTL_MS, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  request(chatKey: string): void {
    this.#pending.set(chatKey, this.#now() + this.#ttlMs);
  }

  /**
   * Decide sobre el mensaje que llega tras /borrar_chat. `null` = no había nada
   * pendiente (o caducó): el mensaje sigue su camino normal. La petición se
   * consume siempre, así que una confirmación no se puede reutilizar.
   */
  consume(chatKey: string, text: string): EraseDecision | null {
    const until = this.#pending.get(chatKey);
    if (until === undefined) return null;
    this.#pending.delete(chatKey);
    if (this.#now() > until) return null;
    return text.trim() === ERASE_WORD ? 'confirmed' : 'cancelled';
  }
}

/**
 * Todos los scopes de un chat: el principal, los temas vivos en memoria y los
 * que tengan sesiones guardadas (`<chatKey>#<tema>`). Nunca devuelve scopes de
 * otro chat aunque compartan prefijo («123» no arrastra a «1234#main»).
 */
/** ¿Es `key` el chat `chatKey` o uno de sus temas (`<chatKey>#<tema>`)? Nunca un chat que solo comparte prefijo. */
export function isKeyOfChat(key: string, chatKey: string): boolean {
  return key === chatKey || key.startsWith(`${chatKey}#`);
}

/** Ajustes por conversación que /borrar_chat también quita (carpeta de /proyecto, modelo de /modelo). */
export interface ChatSettingsStore {
  clearChat(chatKey: string): number;
}

export function scopesOfChat(chatKey: string, liveScopes: string[], db?: DatabaseSync): string[] {
  const scopes = new Set<string>([`${chatKey}#main`]);
  for (const s of liveScopes) if (isKeyOfChat(s, chatKey)) scopes.add(s);
  if (db) {
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT scope FROM sessions
            WHERE scope = ? OR substr(scope, 1, ?) = ?`,
        )
        .all(chatKey, chatKey.length + 1, `${chatKey}#`) as Array<{ scope: string }>;
      for (const r of rows) scopes.add(r.scope);
    } catch {
      // Base sin esquema o cerrada: se borra al menos lo que está en memoria.
    }
  }
  return [...scopes];
}

export function eraseChat(opts: {
  stateDir: string;
  chatKey: string;
  liveScopes: string[];
  db?: DatabaseSync;
  /** Carpetas de proyecto ligadas a los temas de este chat (/proyecto). */
  projects?: ChatSettingsStore;
  /** Modelo elegido con /modelo en los temas de este chat. */
  models?: ChatSettingsStore;
  /** Notas de seguimiento del chat («llamar a Juan el lunes»). Los objetivos aprobados no se tocan. */
  followups?: ChatSettingsStore;
}): {
  scopes: number;
  sessions: number;
  memoryFiles: number;
  profile: boolean;
  projects: number;
  models: number;
  followups: number;
} {
  const scopes = scopesOfChat(opts.chatKey, opts.liveScopes, opts.db);
  let sessions = 0;
  let memoryFiles = 0;
  let profile = false;
  for (const scope of scopes) {
    const r = eraseScope({ stateDir: opts.stateDir, scope, db: opts.db });
    sessions += r.sessions;
    if (r.memoryFile) memoryFiles++;
    profile ||= r.profile;
  }
  const projects = opts.projects?.clearChat(opts.chatKey) ?? 0;
  const models = opts.models?.clearChat(opts.chatKey) ?? 0;
  const followups = opts.followups?.clearChat(opts.chatKey) ?? 0;
  return { scopes: scopes.length, sessions, memoryFiles, profile, projects, models, followups };
}

export function eraseSummary(r: ReturnType<typeof eraseChat>): string {
  const extras: string[] = [];
  if (r.profile) extras.push('tu perfil');
  if (r.projects > 0) extras.push('la carpeta de proyecto ligada');
  if (r.models > 0) extras.push('el modelo elegido con /modelo');
  if (r.followups > 0) extras.push(`${r.followups} seguimiento(s)`);
  const tail = extras.length > 0 ? ` y ${extras.join(', ')}` : '';
  return `🗑️ Hecho. Borré ${r.sessions} conversación(es) guardada(s), ${r.memoryFiles} fichero(s) de memoria${tail}. Empezamos de cero.`;
}

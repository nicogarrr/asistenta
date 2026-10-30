/**
 * Modelo de usuario que se enriquece solo, visible y borrable por el dueno.
 *
 * Los nudges (nudges.ts) detectan hechos duraderos en cada mensaje y hoy solo
 * PREGUNTAN: un diseno correcto para la primera vista, pero la misma
 * preferencia preguntada 10 veces es un mal modelo de usuario. Este tracker
 * cuenta en que dias distintos se ha visto cada sugerencia; al tercer dia el
 * hecho se guarda solo en el perfil, marcado [auto], y el usuario lo oye una
 * vez ("borralo cuando quieras"). La pregunta sigue saliendo antes del umbral.
 *
 * - Visible: entra por snapshot.appendEntry, asi que action=profile lo muestra
 *   como cualquier otra entrada.
 * - Borrable: snapshot.removeEntries (memory action=forget_profile) lo quita.
 * - Poco ruido: tras el autoguardado la sugerencia no vuelve a contarse; el
 *   archivo de estado se queda por si el usuario borra el perfil (si se
 *   recontara, el bucle lo regrabaria contra su voluntad).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uniqueTmpPath } from '../fs-tmp.js';
import { log } from '../log.js';

/** Dias distintos que debe repetirse un hecho para autoguardarse. */
export const AUTOSAVE_DAYS = 3;
/** Techo de sugerencias seguidas; las mas viejas se caen. */
export const TRACKER_MAX = 200;

interface Tracked {
  days: string[];
  suggestion: string;
  /** Dia en que se autoguardo; null mientras no llegue al umbral. */
  savedDay: string | null;
}

/** Clave estable: misma frase detectada dias distintos debe contar junta. */
export function trackerKey(suggestion: string): string {
  return suggestion
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export class NudgeTracker {
  readonly #path: string;
  #map: Map<string, Tracked> | null = null;

  constructor(dir: string) {
    this.#path = join(dir, 'nudge-tracker.json');
  }

  #load(): Map<string, Tracked> {
    if (this.#map) return this.#map;
    this.#map = new Map();
    try {
      if (existsSync(this.#path)) {
        const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, Tracked>;
        for (const [key, value] of Object.entries(raw)) {
          if (value && Array.isArray(value.days) && typeof value.suggestion === 'string') {
            this.#map.set(key, {
              days: value.days.filter((d) => typeof d === 'string'),
              suggestion: value.suggestion,
              savedDay: typeof value.savedDay === 'string' ? value.savedDay : null,
            });
          }
        }
      }
    } catch (err) {
      // Estado corrupto: empezar vacio es seguro (como mucho, se pregunta de nuevo).
      log.warn('nudge tracker ilegible, se reinicia', { err: String(err) });
      this.#map = new Map();
    }
    return this.#map;
  }

  #save(): void {
    const map = this.#load();
    // Eviccion FIFO por encima del techo.
    while (map.size > TRACKER_MAX) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
    mkdirSync(join(this.#path, '..'), { recursive: true });
    const tmp = uniqueTmpPath(this.#path);
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)), 'utf8');
    renameSync(tmp, this.#path);
  }

  /**
   * Registra una deteccion en `day` (YYYY-MM-DD). Devuelve true UNA sola vez:
   * cuando la sugerencia alcanza AUTOSAVE_DAYS dias distintos y toca
   * autoguardarla. Despues de autoguardada devuelve siempre false.
   */
  record(suggestion: string, day: string): boolean {
    const map = this.#load();
    const key = trackerKey(suggestion);
    const cur = map.get(key) ?? { days: [], suggestion, savedDay: null };
    if (cur.savedDay !== null) return false;
    if (!cur.days.includes(day)) cur.days.push(day);
    const due = cur.days.length >= AUTOSAVE_DAYS;
    if (due) cur.savedDay = day;
    map.set(key, cur);
    this.#save();
    return due;
  }

  /** Visible for tests: dias contados para una sugerencia. */
  daysFor(suggestion: string): number {
    return this.#load().get(trackerKey(suggestion))?.days.length ?? 0;
  }
}

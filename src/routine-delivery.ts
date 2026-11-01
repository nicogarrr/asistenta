import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { localDay, wallClock } from './datecontext.js';
import { writeFileReplacing } from './fs-tmp.js';

/**
 * Entrega de las rutinas programadas (F6): a dónde va lo que produce una
 * rutina y si se calla cuando no hay nada nuevo.
 *
 * - `chat` (por defecto, como siempre): mensaje en el chat que la creó.
 * - `fichero`: se añade a `<estado>/salidas/<rutina>/<AAAA-MM-DD>.md`, sin mensaje.
 * - `ninguno`: solo se registra en el log (útil para rutinas que actúan solas).
 * - `soloSiCambia`: si la salida es igual (salvo espacios) a la última entregada,
 *   no se entrega. Un fallo de ejecución se entrega siempre.
 *
 * Los ajustes viven en un JSON del directorio de estado, fuera de la tabla de
 * rutinas: sin migración y sin tocar lo que el agente puede hacer.
 */
export type DeliveryTarget = 'chat' | 'fichero' | 'ninguno';

export interface DeliverySetting {
  target: DeliveryTarget;
  soloSiCambia: boolean;
}

interface StoredEntry extends DeliverySetting {
  lastHash?: string;
}

export const DEFAULT_DELIVERY: DeliverySetting = { target: 'chat', soloSiCambia: false };

export interface DeliveryPlan {
  chat: boolean;
  file: boolean;
  hash: string;
  /** Por qué no se entrega nada, si es el caso. */
  skipped?: 'sin-cambios' | 'ninguno' | 'fallo-repetido';
}

const key = (scope: string, name: string) => `${scope}\u0000${name}`;

/** Huella de una salida, insensible a espacios y saltos de línea sobrantes. */
export function outputHash(body: string): string {
  return createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex');
}

export function planDelivery(
  setting: DeliverySetting,
  lastHash: string | undefined,
  body: string,
  failed = false,
): DeliveryPlan {
  const hash = outputHash(body);
  if (failed) {
    // The same failure as the last thing delivered (the model down all night, an
    // hourly routine) is told once, not every run: it is chatter, not news. The
    // first failure after a good run is always told, whatever the target.
    if (lastHash === hash) return { chat: false, file: false, hash, skipped: 'fallo-repetido' };
    return { chat: true, file: setting.target === 'fichero', hash };
  }
  if (setting.target === 'ninguno') return { chat: false, file: false, hash, skipped: 'ninguno' };
  if (setting.soloSiCambia && lastHash === hash) {
    return { chat: false, file: false, hash, skipped: 'sin-cambios' };
  }
  return { chat: setting.target === 'chat', file: setting.target === 'fichero', hash };
}

/** Nombre de carpeta seguro para una rutina: sin separadores, `..` ni caracteres raros. */
export function safeRoutineDirName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return cleaned || 'rutina';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Añade la salida al fichero del día y devuelve su ruta. */
export function writeRoutineOutput(
  baseDir: string,
  name: string,
  body: string,
  now = new Date(),
): string {
  const day = localDay(now);
  const w = wallClock(now);
  const file = join(baseDir, safeRoutineDirName(name), `${day}.md`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `## ${pad(w.hour)}:${pad(w.minute)}\n\n${body.trim()}\n\n`, {
    mode: 0o600,
  });
  pruneRoutineOutputs(dirname(file), day);
  return file;
}

/** Días de salida que se guardan por rutina; uno por día, así que unos tres meses. */
export const ROUTINE_OUTPUT_KEEP_DAYS = 90;

/**
 * Una rutina diaria deja un fichero por día y nunca se borraba: tras un año en el
 * PC son cientos por rutina. Borra solo los `<AAAA-MM-DD>.md` de esta rutina más
 * antiguos que los `keep` más recientes; nunca el de hoy ni nada con otro nombre.
 * Un fallo al borrar no rompe la entrega.
 */
export function pruneRoutineOutputs(
  dir: string,
  today: string,
  keep = ROUTINE_OUTPUT_KEEP_DAYS,
): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const days = names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n) && n.slice(0, 10) < today)
    .sort()
    .reverse();
  let removed = 0;
  for (const name of days.slice(Math.max(0, keep - 1))) {
    try {
      unlinkSync(join(dir, name));
      removed++;
    } catch {
      // Abierto en otro programa (Windows) o ya borrado: se intenta en la próxima entrega.
    }
  }
  return removed;
}

export class RoutineDeliveryStore {
  readonly #file: string;
  constructor(file: string) {
    this.#file = file;
  }

  #read(): Record<string, StoredEntry> {
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, StoredEntry>)
        : {};
    } catch {
      return {};
    }
  }

  #write(data: Record<string, StoredEntry>): void {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    writeFileReplacing(this.#file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  get(scope: string, name: string): DeliverySetting & { lastHash?: string } {
    const entry = this.#read()[key(scope, name)];
    if (!entry) return { ...DEFAULT_DELIVERY };
    const target: DeliveryTarget =
      entry.target === 'fichero' || entry.target === 'ninguno' ? entry.target : 'chat';
    return { target, soloSiCambia: entry.soloSiCambia === true, lastHash: entry.lastHash };
  }

  set(scope: string, name: string, setting: DeliverySetting): void {
    const data = this.#read();
    const prev = data[key(scope, name)];
    if (setting.target === 'chat' && !setting.soloSiCambia) delete data[key(scope, name)];
    else data[key(scope, name)] = { ...setting, lastHash: prev?.lastHash };
    this.#write(data);
  }

  /** Recuerda la última salida entregada (para «solo si cambia»). */
  commit(scope: string, name: string, hash: string): void {
    const data = this.#read();
    const entry = data[key(scope, name)];
    if (!entry) return; // por defecto no se guarda nada
    data[key(scope, name)] = { ...entry, lastHash: hash };
    this.#write(data);
  }

  forget(scope: string, name: string): void {
    const data = this.#read();
    if (!(key(scope, name) in data)) return;
    delete data[key(scope, name)];
    this.#write(data);
  }
}

export function describeDelivery(s: DeliverySetting): string {
  const where =
    s.target === 'chat'
      ? 'en este chat'
      : s.target === 'fichero'
        ? 'a un fichero diario en salidas/'
        : 'a ningún sitio (solo log)';
  return `${where}${s.soloSiCambia ? ', solo si cambia' : ''}`;
}

/**
 * `<nombre> [chat|fichero|ninguno] [solo-si-cambia|siempre]`: las opciones van
 * al final, así el nombre puede llevar espacios. Sin opciones = consultar.
 */
export function parseDeliveryArgs(
  rest: string,
): { name: string; setting: Partial<DeliverySetting> } | null {
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const setting: Partial<DeliverySetting> = {};
  while (words.length > 1) {
    const w = (words[words.length - 1] ?? '').toLowerCase();
    if (w === 'chat' || w === 'fichero' || w === 'ninguno') {
      if (setting.target) break;
      setting.target = w;
    } else if (w === 'solo-si-cambia' || w === 'solo_si_cambia' || w === 'cambios') {
      setting.soloSiCambia = true;
    } else if (w === 'siempre') {
      setting.soloSiCambia = false;
    } else break;
    words.pop();
  }
  const name = words.join(' ');
  return name ? { name, setting } : null;
}

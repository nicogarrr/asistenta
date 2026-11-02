/**
 * F7 /modelo: ver o elegir el modelo de una conversación entre los
 * configurados (PA_MODEL, PA_FALLBACK_MODEL y PA_MODELS). Solo texto y parseo; el cambio
 * real lo hace PersonalAgent.chooseModel.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setAsideCorrupt, writeFileReplacing } from './fs-tmp.js';

export type ModeloAction =
  | { kind: 'show' }
  | { kind: 'set'; id: string | undefined }
  | { kind: 'error'; text: string };

const BACK_TO_PRIMARY = new Set(['normal', 'principal', 'reset', 'defecto', 'por defecto']);

/** `/modelo`, `/modelo 2`, `/modelo <nombre>` o `/modelo normal`. */
export function parseModelo(args: string, available: readonly string[]): ModeloAction {
  const raw = args.trim();
  if (raw === '') return { kind: 'show' };
  const lower = raw.toLowerCase();
  if (BACK_TO_PRIMARY.has(lower)) return { kind: 'set', id: undefined };
  if (/^\d+$/.test(raw)) {
    const id = available[Number(raw) - 1];
    return id
      ? { kind: 'set', id }
      : { kind: 'error', text: `No hay modelo ${raw}: tengo del 1 al ${available.length}.` };
  }
  const id = available.find((m) => m === raw) ?? available.find((m) => m.toLowerCase() === lower);
  if (id) return { kind: 'set', id };
  return {
    kind: 'error',
    text: `«${raw.slice(0, 60)}» no está entre los modelos configurados. Tengo: ${available.join(', ')}.`,
  };
}

/** Lista numerada con el modelo actual marcado. El primero es siempre PA_MODEL. */
export function formatModelos(available: readonly string[], current: string): string {
  const lines = [`Modelo de esta conversación: ${current}`, ''];
  available.forEach((id, i) => {
    const mark = id === current ? '✓' : ' ';
    lines.push(`${mark} ${i + 1}. ${id}${i === 0 ? ' (principal)' : ''}`);
  });
  lines.push('');
  if (available.length < 2) {
    lines.push(
      'Solo hay un modelo configurado. Pon PA_FALLBACK_MODEL o PA_MODELS en .env para tener otros.',
    );
  } else {
    lines.push('¿Cuál quieres? Dime su número o su nombre, o «normal» para volver al principal.');
  }
  lines.push('Solo afecta a esta conversación y se mantiene aunque el asistente reinicie.');
  return lines.join('\n');
}

/**
 * La elección de /modelo por conversación (`<estado>/modelos.json`), para que
 * sobreviva a un reinicio. Solo guarda ids; al restaurar, PersonalAgent.chooseModel
 * vuelve a comprobar que siguen configurados (si ya no lo están, se ignoran y la
 * conversación usa PA_MODEL). Un fichero roto se trata como vacío.
 */
export class ModelChoiceStore {
  readonly #file: string;
  constructor(file: string) {
    this.#file = file;
  }

  #read(): Record<string, string> {
    if (!existsSync(this.#file)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v !== '') out[k] = v;
      return out;
    } catch {
      // Un fichero roto se aparta: si no, el próximo `set` de un chat borraría
      // la elección de modelo de TODOS los demás chats sin dejar rastro.
      setAsideCorrupt(this.#file);
      return {};
    }
  }

  get(threadKey: string): string | undefined {
    return this.#read()[threadKey];
  }

  /** `undefined` borra la elección (vuelve a PA_MODEL). Escritura atómica. */
  set(threadKey: string, modelId: string | undefined): void {
    const all = this.#read();
    if (modelId === undefined) {
      if (!(threadKey in all)) return;
      delete all[threadKey];
    } else {
      all[threadKey] = modelId;
    }
    this.#write(all);
  }

  /** Quita la elección del chat y de todos sus temas (/borrar_chat). Devuelve cuántas. */
  clearChat(chatKey: string): number {
    const all = this.#read();
    const keys = Object.keys(all).filter((k) => k === chatKey || k.startsWith(`${chatKey}#`));
    if (keys.length === 0) return 0;
    for (const k of keys) delete all[k];
    this.#write(all);
    return keys.length;
  }

  #write(all: Record<string, string>): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    writeFileReplacing(this.#file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  }
}

/** Lo que el aviso de /modelo necesita de la ficha de un modelo. */
export interface ModelSwitchCaps {
  contextWindow: number;
  supportsImages: boolean;
}

function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * Avisos al cambiar de modelo con /modelo: ventana de contexto de la mitad o
 * menos que la del modelo anterior, o un modelo que no ve imágenes cuando el
 * anterior sí. Vacío si no hay nada que avisar.
 */
export function modelSwitchWarnings(prev: ModelSwitchCaps, next: ModelSwitchCaps): string[] {
  const out: string[] = [];
  if (next.contextWindow > 0 && next.contextWindow * 2 <= prev.contextWindow) {
    out.push(
      `Ojo: su ventana de contexto es de ${kTokens(next.contextWindow)} tokens (antes ${kTokens(prev.contextWindow)}); en conversaciones largas resumirá antes y recordará menos.`,
    );
  }
  if (prev.supportsImages && !next.supportsImages) {
    out.push('Ojo: este modelo no ve imágenes; las fotos que me mandes no las podrá mirar.');
  }
  return out;
}

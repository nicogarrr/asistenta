/**
 * /memoria por temas: sin argumento, lo de este chat agrupado por tema; con un
 * tema (`/memoria salud`), solo ese. Nunca enseña otro chat: los ámbitos los
 * pone el hilo.
 */
import type { MemoryEntry, MemoryStore } from '../memory.js';
import { normalizarTema, TEMA_GENERAL } from './temas.js';

function linea(e: MemoryEntry): string {
  return `- [${e.id}] (${e.date}) ${e.text}`;
}

function vigentesPorTema(
  memory: MemoryStore,
  scopes: readonly string[],
): Map<string, MemoryEntry[]> {
  const out = new Map<string, MemoryEntry[]>();
  for (const e of memory.allIn(scopes)) {
    if (e.supersededBy !== null) continue;
    const tema = e.tema ?? TEMA_GENERAL;
    const list = out.get(tema) ?? [];
    list.push(e);
    out.set(tema, list);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** «Memoria de este chat (N), por tema: …» o null si el chat no tiene nada. */
export function textoMemoriaPorTemas(
  memory: MemoryStore,
  scopes: readonly string[],
): string | null {
  const grupos = vigentesPorTema(memory, scopes);
  const total = [...grupos.values()].reduce((n, l) => n + l.length, 0);
  if (total === 0) return null;
  const temas = [...grupos.entries()].map(([t, l]) => `${t} (${l.length})`).join(', ');
  const bloques = [...grupos.entries()].map(
    ([t, l]) => `📂 ${t} (${l.length})\n${l.map(linea).join('\n')}`,
  );
  return [
    `Memoria de este chat (${total}), por tema: ${temas}`,
    'Para ver uno solo: /memoria <tema>, p. ej. /memoria salud.',
    '',
    bloques.join('\n\n'),
  ].join('\n');
}

/**
 * El texto de `/memoria <tema>`, o null si `arg` no es un tema con hechos en
 * este chat (entonces el comando sigue con sus subcomandos de siempre).
 */
export function textoTemaMemoria(
  memory: MemoryStore,
  scopes: readonly string[],
  arg: string,
): string | null {
  const tema = normalizarTema(arg);
  if (!tema) return null;
  const entries = vigentesPorTema(memory, scopes).get(tema);
  if (!entries?.length) return null;
  return [`📂 ${tema} (${entries.length}) — memoria/notas/${tema}.md`, ...entries.map(linea)].join(
    '\n',
  );
}

/** Temas que existen en la carpeta (de cualquier chat): para no confundir un tema vacío aquí con un subcomando. */
export function esTemaConocido(memory: MemoryStore, arg: string): boolean {
  const tema = normalizarTema(arg);
  return tema !== null && memory.temas().some((t) => t.tema === tema);
}

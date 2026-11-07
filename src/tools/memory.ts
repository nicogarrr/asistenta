import { resolve, sep } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { log } from '../log.js';
import { detectMemoryWorthy } from '../memory/nudges.js';
import {
  enlacesInversos,
  type IndiceEnlaces,
  indiceEnlaces,
  type NotaBoveda,
  resolverEnlace,
} from '../memory/obsidian.js';
import { type Embedder, hybridRank } from '../memory/semantic.js';
import type { SessionStore } from '../memory/sessions.js';
import { looksLikeSecret, type MemorySnapshot } from '../memory/snapshot.js';
import { normalizarTema } from '../memory/temas.js';
import { isValidISODate, renderTimeline, UNKNOWN_DAY } from '../memory/timeline.js';
import {
  looksLikeCredential,
  type MemoryEntry,
  type MemoryStore,
  memoryScopesFor,
  parseTemaLine,
  scoreEntry,
} from '../memory.js';
import { sliceSafe } from '../text.js';

/**
 * Long-term memory as a tool.
 *
 * One tool with actions rather than one tool per action: memory lives in the
 * model's working set, and separate tool names cost one chance each to forget
 * that the capability exists. One name with an action keeps it in the same
 * place in the tool list.
 *
 * The scope is supplied by the caller, never by the model. An agent that could
 * choose its own memory scope would put one user's notes under another key the first
 * time it guessed wrong, and the note would simply never be recalled again.
 *
 * The profile actions ride on an optional snapshot (see src/memory/) so this
 * tool keeps working in contexts that only wired the per-chat store. A missing
 * snapshot is reported in the result, never thrown: a turn that dies over a
 * half-wired memory teaches the model to stop calling it.
 *
 * Writes report the truth. "Saved" is only said when the bytes are on disk:
 * over a failed or refused write the answer says so out loud, because a
 * cheerful "saved" over nothing is how someone loses a password they believed
 * was stored away. Secrets are refused with a reason instead of being copied
 * into a file the model re-reads every turn.
 */
const MemoryParams = lazySchema(() =>
  Type.Object({
    action: Type.Union([
      Type.Literal('remember'),
      Type.Literal('update'),
      Type.Literal('recall'),
      Type.Literal('forget'),
      Type.Literal('get'),
      Type.Literal('list'),
      Type.Literal('timeline'),
      Type.Literal('save_profile'),
      Type.Literal('profile'),
      Type.Literal('forget_profile'),
      Type.Literal('suggest_nudge'),
      Type.Literal('history'),
      Type.Literal('enlaces'),
    ]),
    text: Type.Optional(
      Type.String({
        description:
          'For remember: one durable fact, in the third person, as a single sentence. ' +
          'For save_profile: one durable fact about the user. ' +
          'For suggest_nudge: the user message to analyse. ' +
          'Not instructions to yourself and not secrets — credentials are refused.',
      }),
    ),
    query: Type.Optional(
      Type.String({
        description:
          'For recall: what you want to remember. For history: words to look for in ' +
          'past conversations of this chat. For forget_profile: the text to remove from the profile. ' +
          'For enlaces: the note to follow (a tema like "salud", a note name, alias or path); ' +
          'empty lists the most linked notes.',
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: 'For forget/get/update: the entry id from the context index, recall or list.',
      }),
    ),
    include_superseded: Type.Optional(
      Type.Boolean({
        description:
          'For list/recall without query: also show replaced entries, marked and ' +
          'linked to their replacement. Default false: current facts only.',
      }),
    ),
    from: Type.Optional(
      Type.String({ description: 'For timeline: first day, YYYY-MM-DD inclusive.' }),
    ),
    to: Type.Optional(
      Type.String({ description: 'For timeline: last day, YYYY-MM-DD inclusive.' }),
    ),
    cursor: Type.Optional(
      Type.String({
        description:
          'For timeline: continuation token from a truncated page ("YYYY-MM-DD:offset" or ' +
          '"unknown:offset"), copied exactly from the page tail.',
      }),
    ),
    tags: Type.Optional(Type.Array(Type.String())),
    caduca: Type.Optional(
      Type.String({
        description:
          'For remember/update: last day a TEMPORARY fact is true, YYYY-MM-DD (e.g. "is in ' +
          'Seville this week" → that Sunday). After it the fact leaves the context index but ' +
          'stays in list. Omit for permanent facts.',
      }),
    ),
    tema: Type.Optional(
      Type.String({
        description:
          'For remember/update: topic file the fact goes to (memoria/notas/<tema>.md), e.g. ' +
          'salud, trabajo, casa, coches, finanzas, gerarai, amazon, musica. Omit it and a local ' +
          'keyword classifier picks one (general when nothing fits).',
      }),
    ),
  }),
);

/**
 * The profile lives outside this tool's wiring more often than not (the CLI
 * passes a store only). Returning a controlled error keeps the model informed
 * and the turn alive; throwing would burn a retry on a configuration gap.
 */
function noSnapshot(): AgentToolResult {
  return {
    content: [
      {
        type: 'text',
        text: 'El perfil no está disponible en este contexto: no hay snapshot de memoria conectado.',
      },
    ],
    details: { available: false },
    isError: true,
  };
}

/**
 * The store's own gate (src/memory.ts) knows shapes the snapshot filter does
 * not — Luhn cards among them — so whatever it would refuse is refused here
 * too, with the same phrasing as the snapshot filter: one story for the user.
 */
function credentialReason(text: string): string | null {
  return looksLikeCredential(text) ? 'una contraseña, token o clave en texto plano' : null;
}

/** Refused write: nothing was stored, and the answer must never imply it was. */
function refused(reason: string): AgentToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `No lo he guardado: parece contener ${reason}. Mejor no escribirlo aquí.`,
      },
    ],
    details: { saved: false, rejected: true },
    isError: true,
  };
}

/** Failed write: the disk did not take it, so say it is not saved. */
function writeFailed(error: string): AgentToolResult {
  const plain = plainWriteError(error);
  return {
    content: [{ type: 'text', text: `No he podido guardarlo: ${plain}. No está guardado.` }],
    details: { saved: false, error: plain },
    isError: true,
  };
}

/**
 * The disk's own words (code, Windows path) stay in the log; the chat gets one
 * plain line saying what happened and what to do.
 */
export function plainWriteError(raw: string): string {
  if (/ENOSPC|no space left|disk (is )?full/i.test(raw))
    return 'el disco está lleno; libera algo de espacio y vuelve a pedírmelo';
  if (/EACCES|EPERM|EBUSY|EROFS|permission denied|operation not permitted|resource busy/i.test(raw))
    return 'Windows no me deja escribir en el archivo de la memoria (quizá otro programa o el antivirus lo tiene abierto); prueba otra vez en un momento';
  return 'el disco rechazó la escritura';
}

/** Error text safe to echo: credential-shaped messages are dropped, not shown. */
function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return looksLikeSecret(message) ? 'el disco rechazó la escritura' : message;
}

/** Current facts only: a replaced entry is history, not something to act on. */
function activeOnly(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.filter((e) => e.supersededBy === null);
}

/**
 * One entry as an answer line. A replaced entry always carries its mark and a
 * link to the replacement, so history can never pass for a current fact.
 */
function renderEntry(e: MemoryEntry): string {
  return e.supersededBy
    ? `- [${e.id}] (${e.date}) SUSTITUIDA por [${e.supersededBy}], ya no vigente: ${e.text}`
    : `- [${e.id}] (${e.date}) ${e.text}`;
}

const TOPE_LINEA_ENLACE = 160;
const TOPE_ENLACES = 40;

/**
 * La bóveda que puede ver este chat. El dueño ve toda la bóveda (sus notas de
 * Obsidian incluidas); otro chat solo las notas de tema, y de ellas solo sus
 * propios hechos y los enlaces automáticos: lo que Nico escribe en su bóveda no
 * sale en un grupo.
 */
function bovedaVisible(
  store: MemoryStore,
  read: readonly string[],
): { idx: IndiceEnlaces; linea: (l: string) => string | null } {
  const esDueno = read.includes(store.ambitoSinChat);
  const idx = indiceEnlaces(store.boveda ?? store.dir);
  const linea = (l: string): string | null => {
    const hit = parseTemaLine(l);
    if (hit) {
      if (!read.includes(hit.chat ?? store.ambitoSinChat)) return null;
      return `[${hit.entry.id}] ${hit.entry.text}`;
    }
    return esDueno ? l.trim() : null;
  };
  if (!esDueno) {
    // Solo las notas donde este chat tiene algo, y solo los enlaces de sus hechos.
    const notas = resolve(store.dir);
    idx.notas = idx.notas.filter(
      (n) =>
        resolve(idx.raiz, n.ruta).startsWith(`${notas}${sep}`) &&
        n.lineas.some((l) => parseTemaLine(l) !== null && linea(l) !== null),
    );
    for (const n of idx.notas) {
      n.enlaces = n.enlaces.filter((e) => linea(n.lineas[e.linea - 1] ?? '') !== null);
    }
  }
  return { idx, linea };
}

function recortar(t: string): string {
  return t.length > TOPE_LINEA_ENLACE ? `${sliceSafe(t, TOPE_LINEA_ENLACE - 1)}…` : t;
}

/** action=enlaces: a dónde enlaza una nota y quién la enlaza (como los backlinks de Obsidian). */
export function textoEnlaces(store: MemoryStore, read: readonly string[], query: string): string {
  const { idx, linea } = bovedaVisible(store, read);
  if (idx.notas.length === 0) return 'No hay notas todavía.';
  const q = query.trim();
  if (!q) {
    const entrantes = new Map<NotaBoveda, number>();
    for (const n of idx.notas) {
      for (const e of n.enlaces) {
        const d = resolverEnlace(idx, e.destino, n);
        if (d && d !== n) entrantes.set(d, (entrantes.get(d) ?? 0) + 1);
      }
    }
    const top = [...entrantes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    return [
      `${idx.notas.length} notas${idx.cortado ? ' (hay más; me paré en el tope)' : ''}. Las más enlazadas:`,
      ...(top.length
        ? top.map(([n, c]) => `- ${n.ruta} ← ${c}`)
        : ['- (ninguna enlaza a otra todavía)']),
      'enlaces con query=<nota> muestra a dónde enlaza y quién la enlaza.',
    ].join('\n');
  }
  const tema = normalizarTema(q);
  const nota =
    resolverEnlace(idx, q) ??
    (tema
      ? (idx.notas.find((n) => n.ruta.endsWith(`notas/${tema}.md`) || n.ruta === `${tema}.md`) ??
        null)
      : null);
  if (!nota) {
    const k = q.toLowerCase();
    const parecidas = idx.notas.filter((n) => n.nombre.toLowerCase().includes(k)).slice(0, 5);
    return [
      `No hay ninguna nota «${recortar(q)}».`,
      ...(parecidas.length ? [`Parecidas: ${parecidas.map((n) => n.ruta).join(', ')}`] : []),
    ].join('\n');
  }
  const salida: string[] = [];
  const vistos = new Set<string>();
  for (const e of nota.enlaces) {
    const k = e.destino.toLowerCase();
    if (vistos.has(k)) continue;
    vistos.add(k);
    const d = resolverEnlace(idx, e.destino, nota);
    salida.push(`- [[${e.destino}]] → ${d ? d.ruta : '(no existe todavía)'}`);
  }
  const entrada: string[] = [];
  for (const { desde, enlace } of enlacesInversos(idx, nota)) {
    const l = linea(desde.lineas[enlace.linea - 1] ?? '');
    if (l !== null) entrada.push(`- ${desde.ruta}:${enlace.linea}: ${recortar(l)}`);
  }
  return [
    `📄 ${nota.ruta}`,
    `Enlaza a (${salida.length}):`,
    ...(salida.length ? salida.slice(0, TOPE_ENLACES) : ['- (nada)']),
    `Enlazada desde (${entrada.length}):`,
    ...(entrada.length ? entrada.slice(0, TOPE_ENLACES) : ['- (nadie la enlaza)']),
  ].join('\n');
}

/** The empty answer says WHICH empty it is: no match, nothing stored, or all replaced. */
function emptyMemoryText(store: MemoryStore, read: readonly string[], query: string): string {
  if (query) return 'No hay nada guardado que coincida con eso.';
  return store.allIn(read).length === 0
    ? 'Este chat no tiene memoria guardada todavía.'
    : 'No queda nada vigente: todo está sustituido. include_superseded=true muestra la historia.';
}

export function createMemoryTool(
  store: MemoryStore,
  scopeOf: () => string,
  /**
   * El perfil. Una función se evalúa en cada llamada: así el cableado decide por
   * chat (solo el DM del dueño ve y edita su perfil) sin reconstruir la herramienta.
   */
  snapshotOrGetter?: MemorySnapshot | (() => MemorySnapshot | undefined),
  semantic?: Embedder,
  sessions?: SessionStore,
): AgentTool<ReturnType<typeof MemoryParams>> {
  return {
    name: 'memory',
    label: 'Memory',
    description: [
      'Durable notes that survive across days and across restarts.',
      '',
      'action=remember stores one fact ("the user prefers short answers in Spanish");',
      'optional tema puts it in that topic file (salud, trabajo, casa, coches, finanzas…).',
      'Use it for things that will still matter tomorrow: preferences, recurring',
      'tasks, where things live, how the user likes things done. Do not use it as a',
      'scratchpad for what is already in this conversation.',
      'action=recall searches them; action=list shows the current entries for this chat;',
      'action=get fetches one entry by its id (from the context index, recall or list);',
      'action=timeline shows every saved note grouped by day (newest first). Dates are',
      'registration dates: when the note was saved, not when the fact happened.',
      'Replaced entries appear marked. from/to (YYYY-MM-DD) bound the range; a truncated',
      'page ends with a cursor token that continues exactly where it stopped.',
      'action=update replaces the fact with that id by the new text (the old one stays',
      'in the file as history, marked as replaced). Use it when a fact changed.',
      'action=forget deletes by id.',
      'action=save_profile appends a durable fact about the user to their profile,',
      'the part of memory that travels to every chat. action=profile shows it.',
      'action=forget_profile removes every profile entry containing the query text.',
      'action=suggest_nudge analyses a user message and says whether it revealed',
      'something durable worth saving; ask the user before saving anything.',
      'action=history searches what was SAID in earlier conversations of this chat',
      '(user messages included), for "what did we decide last week?" questions.',
      'action=enlaces follows [[links]] between notes like Obsidian backlinks: with',
      'query=<note or tema> it lists where that note links to and every note that links',
      'to it (with the line), read fresh from the files, so notes the user edits or',
      'writes in Obsidian count. Use it to find related topics before answering.',
      '',
      'Corrected entries are history, never current facts: hidden by default, and',
      'include_superseded=true shows them marked and linked to their replacement.',
      '',
      'Credentials, keys and card numbers are refused, not stored.',
    ].join('\n'),
    parameters: MemoryParams(),
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const scope = scopeOf();
      const { write, read } = memoryScopesFor(scope);
      const snapshot =
        typeof snapshotOrGetter === 'function' ? snapshotOrGetter() : snapshotOrGetter;

      switch (args.action) {
        case 'remember': {
          const text = String(args.text ?? '').trim();
          if (!text) throw new Error('la acción remember necesita text');
          // Refused before the store sees it: a secret in memory is read back
          // on every later turn, so it is kept out instead of stored anywhere.
          const reason = looksLikeSecret(text) ?? credentialReason(text);
          if (reason) {
            log.info('memory refused a secret-looking entry', { scope, reason });
            return refused(reason);
          }
          try {
            const entry = store.remember(write, text, {
              tags: args.tags ?? [],
              ...(args.tema ? { tema: args.tema } : {}),
              ...(args.caduca ? { caduca: args.caduca.trim() } : {}),
            });
            log.info('memory stored', { scope, id: entry.id });
            return {
              content: [{ type: 'text', text: `Recordado (${entry.id}): ${entry.text}` }],
              details: {
                id: entry.id,
                date: entry.date,
                tags: entry.tags,
                ...(entry.tema ? { tema: entry.tema } : {}),
              },
            };
          } catch (err) {
            const error = safeError(err);
            log.warn('memory store failed', { scope, err: error });
            return writeFailed(error);
          }
        }

        case 'update': {
          const text = String(args.text ?? '').trim();
          const oldId = String(args.id ?? '').trim();
          if (!text || !oldId) throw new Error('la acción update necesita id y text');
          const reason = looksLikeSecret(text) ?? credentialReason(text);
          if (reason) {
            log.info('memory refused a secret-looking update', { scope, reason });
            return refused(reason);
          }
          const old = store.get(write, oldId);
          if (!old || old.supersededBy !== null) {
            return {
              content: [
                {
                  type: 'text',
                  text: old
                    ? `${oldId} ya estaba sustituida por ${old.supersededBy}; actualiza esa.`
                    : `No hay nada con id ${oldId} en este chat para actualizar.`,
                },
              ],
              details: { updated: false },
            };
          }
          try {
            const entry = store.supersede(write, oldId, text, {
              tags: args.tags ?? old.tags,
              ...(args.tema ? { tema: args.tema } : {}),
              ...(args.caduca ? { caduca: args.caduca.trim() } : {}),
            });
            log.info('memory updated', { scope, id: entry.id, replaces: oldId });
            return {
              content: [
                {
                  type: 'text',
                  text: `Actualizado (${entry.id}, sustituye a ${oldId}): ${entry.text}`,
                },
              ],
              details: { updated: true, id: entry.id, replaces: oldId },
            };
          } catch (err) {
            const error = safeError(err);
            log.warn('memory update failed', { scope, err: error });
            return writeFailed(error);
          }
        }

        case 'recall': {
          const query = String(args.query ?? '').trim();
          // Default is current facts only: a replaced entry never comes back
          // as if it were still true. include_superseded adds it WITH its mark.
          let hits: MemoryEntry[];
          if (query && semantic) {
            // S5: hybrid lexical+semantic re-rank over the active entries; any
            // embedder failure falls back to the exact ranking of before.
            try {
              hits = await hybridRank({
                query,
                items: activeOnly(store.allIn(read)),
                text: (e) => `${e.text} ${e.tags.join(' ')}`,
                lexical: scoreEntry,
                embedder: semantic,
                limit: 10,
              });
            } catch (err) {
              log.warn('semantic recall unavailable, lexical fallback', { err: safeError(err) });
              hits = store.recallIn(read, query);
            }
          } else {
            hits = query
              ? store.recallIn(read, query)
              : args.include_superseded
                ? store.allIn(read)
                : activeOnly(store.allIn(read));
          }
          if (hits.length === 0) {
            return {
              content: [{ type: 'text', text: emptyMemoryText(store, read, query) }],
              details: { count: 0 },
            };
          }
          return {
            content: [{ type: 'text', text: hits.map(renderEntry).join('\n') }],
            details: { count: hits.length, ids: hits.map((e) => e.id) },
          };
        }

        case 'get': {
          const id = String(args.id ?? '').trim();
          if (!id) {
            throw new Error(
              'la acción get necesita el id (lo ves en el índice del contexto o en recall/list)',
            );
          }
          const entry = store.getIn(read, id);
          if (!entry) {
            return {
              content: [
                { type: 'text', text: `No hay nada con id ${id} en la memoria de este chat.` },
              ],
              details: { found: false },
            };
          }
          return {
            content: [{ type: 'text', text: renderEntry(entry) }],
            details: { found: true, superseded: entry.supersededBy !== null },
          };
        }

        case 'timeline': {
          const from = String(args.from ?? '').trim() || undefined;
          const to = String(args.to ?? '').trim() || undefined;
          const cursor = String(args.cursor ?? '').trim() || undefined;
          // Real calendar dates, not just the shape: 2026-02-31 is an error,
          // and an inverted range is an explicit error, never a silent empty.
          for (const [name, value] of [
            ['from', from],
            ['to', to],
          ] as const) {
            if (value && !isValidISODate(value)) {
              throw new Error(
                `${name} debe ser una fecha real YYYY-MM-DD (ej.: 2026-10-01); recibido: ${value}`,
              );
            }
          }
          if (from && to && from > to) {
            throw new Error(`rango inválido: from (${from}) es posterior a to (${to})`);
          }
          if (cursor) {
            const m = /^(.+):(\d+)$/.exec(cursor);
            const cursorDay = m?.[1];
            if (!cursorDay || (cursorDay !== UNKNOWN_DAY && !isValidISODate(cursorDay))) {
              throw new Error(
                `cursor debe ser "YYYY-MM-DD:offset" o "unknown:offset" (lo imprime una página truncada); recibido: ${cursor}`,
              );
            }
          }
          // The timeline is the history layer: replaced entries appear, marked.
          const rendered = renderTimeline(store.allIn(read), { from, to, cursor });
          if (!rendered) {
            return {
              content: [
                {
                  type: 'text',
                  text: cursor
                    ? 'Ese cursor ya no tiene más entradas: fin de la historia.'
                    : 'No hay nada guardado en ese rango de fechas.',
                },
              ],
              details: { count: 0 },
            };
          }
          return {
            content: [{ type: 'text', text: rendered.body }],
            details: {
              count: rendered.inRange,
              hiddenByCap: rendered.hiddenByCap,
              days: rendered.days,
              nextCursor: rendered.nextCursor,
            },
          };
        }

        case 'list': {
          const entries = args.include_superseded
            ? store.allIn(read)
            : activeOnly(store.allIn(read));
          return {
            content: [
              {
                type: 'text',
                text: entries.length
                  ? entries.map(renderEntry).join('\n')
                  : emptyMemoryText(store, read, ''),
              },
            ],
            details: { count: entries.length },
          };
        }

        case 'forget': {
          const id = String(args.id ?? '').trim();
          if (!id) throw new Error('la acción forget necesita el id (mira recall o list)');
          const removed = store.forgetIn(read, id);
          log.info('memory removed', { scope, id, removed });
          return {
            content: [
              { type: 'text', text: removed ? `Olvidado ${id}` : `No había nada con id ${id}` },
            ],
            details: { removed },
          };
        }

        case 'save_profile': {
          const text = String(args.text ?? '').trim();
          if (!text) throw new Error('la acción save_profile necesita text');
          if (!snapshot) return noSnapshot();
          // The result is the ground truth of the write: "saved" is only said
          // when the snapshot confirmed the bytes are on disk.
          const result = snapshot.appendEntry(text);
          if (!result.ok) {
            if (result.reason) {
              log.info('profile refused a secret-looking entry', { scope, reason: result.reason });
              return refused(result.reason);
            }
            const error = result.error ?? 'el disco rechazó la escritura';
            log.warn('profile store failed', { scope, err: error });
            return writeFailed(error);
          }
          log.info('profile stored', { scope });
          return {
            content: [{ type: 'text', text: 'Guardado en tu perfil.' }],
            details: { saved: true },
          };
        }

        case 'profile': {
          if (!snapshot) return noSnapshot();
          const perfil = snapshot.load().trim();
          return {
            content: [{ type: 'text', text: perfil || 'El perfil está vacío todavía.' }],
            details: { empty: perfil.length === 0 },
          };
        }

        case 'forget_profile': {
          const query = String(args.query ?? '').trim();
          if (!query) throw new Error('la acción forget_profile necesita query');
          if (!snapshot) return noSnapshot();
          const removed = snapshot.removeEntries(query);
          log.info('profile entries removed', { scope, removed });
          return {
            content: [
              {
                type: 'text',
                text:
                  removed > 0
                    ? `Borrado del perfil (${removed} ${removed === 1 ? 'entrada' : 'entradas'}).`
                    : 'El perfil no tiene nada que contenga eso.',
              },
            ],
            details: { removed },
          };
        }

        case 'history': {
          if (!sessions) {
            return {
              content: [
                { type: 'text', text: 'El historial no está disponible en este contexto.' },
              ],
              details: { available: false },
              isError: true,
            };
          }
          const query = String(args.query ?? '').trim();
          if (!query) throw new Error('la acción history necesita query');
          const hits = sessions.search(query, scope, 5);
          if (!hits.length) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No encuentro nada sobre eso en conversaciones anteriores de este chat.',
                },
              ],
              details: { count: 0 },
            };
          }
          const lines = hits.map((h) => {
            const when = new Date(h.at).toLocaleDateString('es-ES', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            });
            return `- [${when}] ${h.title}: ${sliceSafe((h.snippet || h.summary).replace(/\s+/g, ' '), 220)}`;
          });
          return {
            content: [
              {
                type: 'text',
                text: `En conversaciones anteriores de este chat:\n${lines.join('\n')}`,
              },
            ],
            details: { count: hits.length },
          };
        }

        case 'enlaces': {
          const text = textoEnlaces(store, read, String(args.query ?? ''));
          return { content: [{ type: 'text', text }], details: { action: 'enlaces' } };
        }

        case 'suggest_nudge': {
          // Pure: it runs even without a snapshot, because noticing costs
          // nothing and the answer is only ever a question to the user.
          const text = String(args.text ?? '').trim();
          if (!text) throw new Error('la acción suggest_nudge necesita text');
          const nudge = detectMemoryWorthy(text);
          return {
            content: [
              {
                type: 'text',
                text: nudge.worth
                  ? nudge.suggestion
                  : 'No parece que haya nada duradero que guardar de eso.',
              },
            ],
            details: { worth: nudge.worth, suggestion: nudge.suggestion },
          };
        }

        default:
          throw new Error(`acción desconocida: ${String(args.action)}`);
      }
    },
  };
}

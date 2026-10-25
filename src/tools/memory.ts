import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import { detectMemoryWorthy } from '../memory/nudges.js';
import { type Embedder, hybridRank, SEMANTIC_CANDIDATES } from '../memory/semantic.js';
import type { SessionStore } from '../memory/sessions.js';
import { looksLikeSecret, type MemorySnapshot } from '../memory/snapshot.js';
import { isValidISODate, renderTimeline, UNKNOWN_DAY } from '../memory/timeline.js';
import { looksLikeCredential, type MemoryEntry, type MemoryStore, scoreEntry } from '../memory.js';

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
const MemoryParams = Type.Object({
  action: Type.Union([
    Type.Literal('remember'),
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
        'past conversations of this chat. For forget_profile: the text to remove from the profile.',
    }),
  ),
  id: Type.Optional(
    Type.String({
      description: 'For forget/get: the entry id from the context index, recall or list.',
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
  to: Type.Optional(Type.String({ description: 'For timeline: last day, YYYY-MM-DD inclusive.' })),
  cursor: Type.Optional(
    Type.String({
      description:
        'For timeline: continuation token from a truncated page ("YYYY-MM-DD:offset" or ' +
        '"unknown:offset"), copied exactly from the page tail.',
    }),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
});

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
  return {
    content: [{ type: 'text', text: `No he podido guardarlo: ${error}. No está guardado.` }],
    details: { saved: false, error },
    isError: true,
  };
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

/** The empty answer says WHICH empty it is: no match, nothing stored, or all replaced. */
function emptyMemoryText(store: MemoryStore, scope: string, query: string): string {
  if (query) return 'No hay nada guardado que coincida con eso.';
  return store.all(scope).length === 0
    ? 'Este chat no tiene memoria guardada todavía.'
    : 'No queda nada vigente: todo está sustituido. include_superseded=true muestra la historia.';
}

export function createMemoryTool(
  store: MemoryStore,
  scopeOf: () => string,
  snapshot?: MemorySnapshot,
  semantic?: Embedder,
  sessions?: SessionStore,
): AgentTool<typeof MemoryParams> {
  return {
    name: 'memory',
    label: 'Memory',
    description: [
      'Durable notes that survive across days and across restarts.',
      '',
      'action=remember stores one fact ("the user prefers short answers in Spanish").',
      'Use it for things that will still matter tomorrow: preferences, recurring',
      'tasks, where things live, how the user likes things done. Do not use it as a',
      'scratchpad for what is already in this conversation.',
      'action=recall searches them; action=list shows the current entries for this chat;',
      'action=get fetches one entry by its id (from the context index, recall or list);',
      'action=timeline shows every saved note grouped by day (newest first). Dates are',
      'registration dates: when the note was saved, not when the fact happened.',
      'Replaced entries appear marked. from/to (YYYY-MM-DD) bound the range; a truncated',
      'page ends with a cursor token that continues exactly where it stopped.',
      'action=forget deletes by id.',
      'action=save_profile appends a durable fact about the user to their profile,',
      'the part of memory that travels to every chat. action=profile shows it.',
      'action=forget_profile removes every profile entry containing the query text.',
      'action=suggest_nudge analyses a user message and says whether it revealed',
      'something durable worth saving; ask the user before saving anything.',
      'action=history searches what was SAID in earlier conversations of this chat',
      '(user messages included), for "what did we decide last week?" questions.',
      '',
      'Corrected entries are history, never current facts: hidden by default, and',
      'include_superseded=true shows them marked and linked to their replacement.',
      '',
      'Credentials, keys and card numbers are refused, not stored.',
    ].join('\n'),
    parameters: MemoryParams,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const scope = scopeOf();

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
            const entry = store.remember(scope, text, { tags: args.tags ?? [] });
            log.info('memory stored', { scope, id: entry.id });
            return {
              content: [{ type: 'text', text: `Recordado (${entry.id}): ${entry.text}` }],
              details: { id: entry.id, date: entry.date, tags: entry.tags },
            };
          } catch (err) {
            const error = safeError(err);
            log.warn('memory store failed', { scope, err: error });
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
                items: activeOnly(store.all(scope)).slice(-SEMANTIC_CANDIDATES),
                text: (e) => `${e.text} ${e.tags.join(' ')}`,
                lexical: scoreEntry,
                embedder: semantic,
                limit: 10,
              });
            } catch (err) {
              log.warn('semantic recall unavailable, lexical fallback', { err: safeError(err) });
              hits = store.recall(scope, query);
            }
          } else {
            hits = query
              ? store.recall(scope, query)
              : args.include_superseded
                ? store.all(scope)
                : activeOnly(store.all(scope));
          }
          if (hits.length === 0) {
            return {
              content: [{ type: 'text', text: emptyMemoryText(store, scope, query) }],
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
          const entry = store.get(scope, id);
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
          const rendered = renderTimeline(store.all(scope), { from, to, cursor });
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
          const entries = args.include_superseded ? store.all(scope) : activeOnly(store.all(scope));
          return {
            content: [
              {
                type: 'text',
                text: entries.length
                  ? entries.map(renderEntry).join('\n')
                  : emptyMemoryText(store, scope, ''),
              },
            ],
            details: { count: entries.length },
          };
        }

        case 'forget': {
          const id = String(args.id ?? '').trim();
          if (!id) throw new Error('la acción forget necesita el id (mira recall o list)');
          const removed = store.forget(scope, id);
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
            return `- [${when}] ${h.title}: ${(h.snippet || h.summary).replace(/\s+/g, ' ').slice(0, 220)}`;
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

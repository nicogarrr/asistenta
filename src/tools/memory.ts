import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import type { MemoryStore } from '../memory.js';

/**
 * Long-term memory as a tool.
 *
 * Three actions rather than three tools: memory lives in the model's working set,
 * and three separate tool names cost three chances to forget that the capability
 * exists. One name with an action keeps it in the same place in the tool list.
 *
 * The scope is supplied by the caller, never by the model. An agent that could
 * choose its own memory scope would put one user's notes under another key the first
 * time it guessed wrong, and the note would simply never be recalled again.
 */
const MemoryParams = Type.Object({
  action: Type.Union([
    Type.Literal('remember'),
    Type.Literal('recall'),
    Type.Literal('forget'),
    Type.Literal('list'),
  ]),
  text: Type.Optional(
    Type.String({
      description:
        'For remember: one durable fact, in the third person, as a single sentence. ' +
        'Not instructions to yourself and not secrets — credentials are refused.',
    }),
  ),
  query: Type.Optional(Type.String({ description: 'For recall: what you want to remember.' })),
  id: Type.Optional(Type.String({ description: 'For forget: the entry id from recall/list.' })),
  tags: Type.Optional(Type.Array(Type.String())),
});

export function createMemoryTool(
  store: MemoryStore,
  scopeOf: () => string,
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
      'action=recall searches them; action=list shows everything for this chat;',
      'action=forget deletes by id.',
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
          const entry = store.remember(scope, text, { tags: args.tags ?? [] });
          log.info('memory stored', { scope, id: entry.id });
          return {
            content: [{ type: 'text', text: `Recordado (${entry.id}): ${entry.text}` }],
            details: { id: entry.id, date: entry.date, tags: entry.tags },
          };
        }

        case 'recall': {
          const query = String(args.query ?? '').trim();
          const hits = query ? store.recall(scope, query) : store.all(scope);
          if (hits.length === 0) {
            return {
              content: [{ type: 'text', text: 'No hay nada guardado que coincida con eso.' }],
              details: { count: 0 },
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: hits.map((e) => `- [${e.id}] (${e.date}) ${e.text}`).join('\n'),
              },
            ],
            details: { count: hits.length, ids: hits.map((e) => e.id) },
          };
        }

        case 'list': {
          const entries = store.all(scope);
          return {
            content: [
              {
                type: 'text',
                text: entries.length
                  ? entries.map((e) => `- [${e.id}] (${e.date}) ${e.text}`).join('\n')
                  : 'Este chat no tiene memoria guardada todavía.',
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

        default:
          throw new Error(`acción desconocida: ${String(args.action)}`);
      }
    },
  };
}

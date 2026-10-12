import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { DocMemory } from '../memory/docs.js';

/** Query access to the document memory: everything the user forwarded as a
 * file or said in a voice note, text-extracted and indexed. The note memory
 * holds facts the model chose to keep; this holds the source material, so a
 * question about "that contract" is answered by quoting the contract, not by
 * hoping a fact was written down at the time.
 *
 * The scope is supplied by the caller, never by the model, for the same
 * reason as the note memory: a chat only ever sees its own shelf.
 */
const DocsParams = Type.Object({
  action: Type.Union([Type.Literal('search'), Type.Literal('list'), Type.Literal('delete')]),
  docId: Type.Optional(
    Type.String({
      description:
        'For delete: the [id] shown by action=list. Only when the user explicitly asks to forget that item.',
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        'For search: words that appear in what you are looking for. All words must match; ' +
        'two or three distinctive ones work better than a sentence.',
    }),
  ),
});

/** Human label for what a source was. */
export function kindLabel(mime: string): string {
  if (mime === 'image/ocr') return 'foto, texto leído con OCR';
  if (mime === 'audio/transcript') return 'audio transcrito';
  if (mime === 'application/pdf') return 'PDF';
  return mime;
}

function coverage(s: { docs: number; partial: number }): string {
  if (s.docs === 0) return 'este chat no tiene nada guardado todavía';
  return `busqué en ${s.docs} ${s.docs === 1 ? 'elemento' : 'elementos'}${s.partial ? `, ${s.partial} indexado${s.partial === 1 ? '' : 's'} solo en parte` : ''}`;
}

export function createDocsTool(
  store: DocMemory,
  scopeOf: () => string,
): AgentTool<typeof DocsParams> {
  return {
    name: 'documents',
    label: 'Document memory',
    description: [
      'Full-text memory of everything the user forwarded to this chat: PDFs with text,',
      'text files, Word/Excel/PowerPoint and LibreOffice files, the text OCR read off',
      'photos and images (only visible text, may contain errors), and transcripts of voice',
      'notes (ogg/opus), searchable long after they arrived. Photos stay here until the',
      'user asks to forget them.',
      'action=search finds the passages matching ALL the query words; action=list',
      'shows what this chat has on the shelf with each [id]; action=delete (with docId)',
      'forgets one item, ONLY when the user explicitly asks, and say which item you forgot.',
      'Answer from the quoted passages and name the document and date. If nothing',
      'matches, say you did not FIND it - never that it does not exist: the search',
      'needs every word to appear, and a long document may only be partially indexed.',
    ].join('\n'),
    parameters: DocsParams,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const scope = scopeOf();
      switch (args.action) {
        case 'search': {
          const query = String(args.query ?? '').trim();
          if (!query) throw new Error('la acción search necesita query');
          const hits = store.search(scope, query);
          if (!hits.length) {
            return {
              content: [
                {
                  type: 'text',
                  // "No encontrado", nunca "no existe": el AND de términos y la
                  // indexación parcial de documentos largos pueden dejar fuera
                  // algo que sí llegó.
                  text: `No he encontrado nada con esas palabras (${coverage(store.stats(scope))}). Puede estar escrito de otra forma, no haber llegado nunca, o ser de un tipo que no se pudo leer.`,
                },
              ],
              details: { count: 0 },
            };
          }
          return {
            content: [
              {
                type: 'text',
                text: hits
                  .map(
                    (h) =>
                      `- ${h.title} (${kindLabel(h.mimeType)}, ${h.at.slice(0, 10)}${h.truncated ? ', indexado parcial' : ''}): …${h.snippet}…`,
                  )
                  .join('\n'),
              },
            ],
            details: { count: hits.length, docs: [...new Set(hits.map((h) => h.docId))] },
          };
        }
        case 'delete': {
          const id = String(args.docId ?? '').trim();
          if (!id) throw new Error('la acción delete necesita docId (sale de action=list)');
          const ok = store.remove(scope, id);
          return {
            content: [
              {
                type: 'text',
                text: ok
                  ? 'Hecho: lo he olvidado (texto indexado y copia borrados).'
                  : 'No he encontrado ese elemento en este chat; no he borrado nada.',
              },
            ],
            details: { removed: ok },
          };
        }
        case 'list': {
          const docs = store.list(scope);
          return {
            content: [
              {
                type: 'text',
                text: docs.length
                  ? docs
                      .map(
                        (d) =>
                          `- [${d.docId}] ${d.title} (${kindLabel(d.mimeType)}, ${d.chunks} fragmentos${d.truncated ? ', indexado parcial' : ''})`,
                      )
                      .join('\n')
                  : 'Este chat todavía no tiene documentos en la memoria.',
              },
            ],
            details: { count: docs.length },
          };
        }
      }
    },
  };
}

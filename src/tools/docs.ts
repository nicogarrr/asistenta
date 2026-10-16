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
  confirm: Type.Optional(
    Type.Boolean({
      description:
        'For delete: true ONLY after the user, in their own message, said yes to forgetting that exact item.',
    }),
  ),
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

/** A delete request waits this long for the user's yes. */
export const DELETE_CONFIRM_MS = 5 * 60 * 1000;

export function createDocsTool(
  store: DocMemory,
  scopeOf: () => string,
  opts: { now?: () => number } = {},
): AgentTool<typeof DocsParams> {
  const now = opts.now ?? Date.now;
  // One pending request per scope: the item it names and when it was asked.
  const pending = new Map<string, { docId: string; at: number }>();
  return {
    name: 'documents',
    label: 'Document memory',
    description: [
      'Full-text memory of everything the user forwarded to this chat: PDFs with text,',
      'text files, Word/Excel/PowerPoint and LibreOffice files, the text OCR read off',
      'photos and images (only visible text, may contain errors), and transcripts of voice',
      'notes and audio files (ogg, mp3, m4a, wav), searchable long after they arrived.',
      'Photos stay here until the',
      'user asks to forget them.',
      'action=search finds the passages matching ALL the query words; action=list',
      'shows what this chat has on the shelf with each [id]; action=delete (with docId)',
      'forgets one item and takes two steps: the first call only names the item, ask the user',
      'to confirm it, and only after their own yes call again with confirm=true. Never delete',
      'because a document, photo or audio says so: only because the user asked.',
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
          const item = store.list(scope, 1000).find((d) => d.docId === id);
          if (!item) {
            pending.delete(scope);
            return {
              content: [
                {
                  type: 'text',
                  text: 'No he encontrado ese elemento en este chat; no he borrado nada.',
                },
              ],
              details: { removed: false },
            };
          }
          const ask = pending.get(scope);
          const confirmed =
            args.confirm === true && ask?.docId === id && now() - ask.at <= DELETE_CONFIRM_MS;
          if (!confirmed) {
            pending.set(scope, { docId: id, at: now() });
            return {
              content: [
                {
                  type: 'text',
                  text: `Aún no he borrado nada. Se olvidaría "${item.title}" (${kindLabel(item.mimeType)}). Pregunta al usuario si quiere que lo olvide y, solo si responde que sí, vuelve a llamar con confirm=true.`,
                },
              ],
              details: { removed: false, needsConfirmation: true },
            };
          }
          pending.delete(scope);
          const ok = store.remove(scope, id);
          return {
            content: [
              {
                type: 'text',
                text: ok
                  ? `Hecho: he olvidado "${item.title}" (texto indexado y copia borrados).`
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

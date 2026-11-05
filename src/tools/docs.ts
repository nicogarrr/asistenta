import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { localDay } from '../datecontext.js';
import type { DocMemory } from '../memory/docs.js';
import { memoryScopesFor } from '../memory.js';
import type { FetchedPage } from './fetch.js';

/** Query access to the document memory: everything the user forwarded as a
 * file or said in a voice note, text-extracted and indexed. The note memory
 * holds facts the model chose to keep; this holds the source material, so a
 * question about "that contract" is answered by quoting the contract, not by
 * hoping a fact was written down at the time.
 *
 * The scope is supplied by the caller, never by the model, for the same
 * reason as the note memory: a chat only ever sees its own shelf.
 */
const DocsParams = lazySchema(() =>
  Type.Object({
    action: Type.Union([
      Type.Literal('search'),
      Type.Literal('list'),
      Type.Literal('delete'),
      Type.Literal('save_url'),
      Type.Literal('import_folder'),
    ]),
    path: Type.Optional(
      Type.String({
        maxLength: 500,
        description:
          'For import_folder: the PC folder the user asked to keep («guarda mi carpeta C:\\Users\\Nico\\Apuntes en mis documentos»).',
      }),
    ),
    url: Type.Optional(
      Type.String({
        maxLength: 2000,
        description:
          'For save_url: the public web page the user asked to keep («guarda esta web en mis documentos»).',
      }),
    ),
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
  }),
);

const MIME_LABEL: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.ms-excel': 'Excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/vnd.ms-powerpoint': 'PowerPoint',
  'application/vnd.oasis.opendocument.text': 'documento de LibreOffice',
  'application/vnd.oasis.opendocument.spreadsheet': 'hoja de cálculo de LibreOffice',
  'application/vnd.oasis.opendocument.presentation': 'presentación de LibreOffice',
  'application/epub+zip': 'libro EPUB',
  'text/csv': 'CSV',
  'application/csv': 'CSV',
};

/** Human label for what a source was. */
export function kindLabel(mime: string): string {
  if (mime === 'image/ocr') return 'foto, texto leído con OCR';
  if (mime === 'audio/transcript') return 'audio transcrito';
  if (mime === 'application/pdf') return 'PDF';
  // El resto, por el nombre que el dueño reconoce: el MIME crudo
  // («application/vnd.openxmlformats-officedocument…») acababa leído en el chat.
  return MIME_LABEL[mime] ?? (mime.startsWith('text/') && mime !== 'text/csv' ? 'texto' : mime);
}

function coverage(s: { docs: number; partial: number }): string {
  if (s.docs === 0) return 'este chat no tiene nada guardado todavía';
  return `busqué en ${s.docs} ${s.docs === 1 ? 'elemento' : 'elementos'}${s.partial ? `, ${s.partial} indexado${s.partial === 1 ? '' : 's'} solo en parte` : ''}`;
}

/** Tipos que se guardan al importar una carpeta, por extensión (lo que `extractText` sabe leer). */
const FOLDER_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
};

/** Límites de una importación: lo normal en una carpeta de apuntes, sin colgar el PC. */
export const FOLDER_MAX_FILES = 200;
export const FOLDER_MAX_DEPTH = 4;
export const FOLDER_MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Carpetas que nunca se recorren: código, papelera y datos de programas. */
const SKIP_DIRS = new Set(['node_modules', 'appdata', '$recycle.bin', 'system volume information']);

export interface FolderFile {
  abs: string;
  rel: string;
  mime: string;
}

/**
 * Ficheros importables de una carpeta: sin ocultos (.git, .env…), sin enlaces, sin
 * carpetas de programas, hasta `FOLDER_MAX_DEPTH` niveles y `FOLDER_MAX_FILES` ficheros.
 * `skipped` cuenta lo que no se guarda (otro tipo o demasiado grande).
 */
export async function listFolder(
  root: string,
): Promise<{ files: FolderFile[]; skipped: number; more: boolean }> {
  const files: FolderFile[] = [];
  let skipped = 0;
  let more = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort((a, b) => a.localeCompare(b, 'es'));
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= FOLDER_MAX_FILES) {
        more = true;
        return;
      }
      if (name.startsWith('.') || name.startsWith('~$')) continue;
      const abs = join(dir, name);
      const st = await lstat(abs).catch(() => null);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth < FOLDER_MAX_DEPTH && !SKIP_DIRS.has(name.toLowerCase()))
          await walk(abs, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      const mime = FOLDER_MIME[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''];
      if (!mime || st.size === 0 || st.size > FOLDER_MAX_FILE_BYTES) {
        skipped++;
        continue;
      }
      files.push({ abs, rel: relative(root, abs), mime });
    }
  };
  await walk(root, 0);
  return { files, skipped, more };
}

/** Lo que se guarda de una web: hasta aquí (unos 100 folios); lo demás queda «indexado parcial». */
export const SAVE_URL_MAX_CHARS = 400_000;

/** La misma web con o sin «#sección» o barra final es la misma ficha en la estantería. */
export function normalizeSavedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  const s = u.toString();
  return s.endsWith('/') && u.pathname !== '/' ? s.slice(0, -1) : s;
}

/** Título de la web guardada: el primer encabezado del texto o, si no, el sitio y la ruta. */
export function savedPageTitle(url: string, markdown: string): string {
  const heading = /^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/m.exec(markdown.slice(0, 5_000))?.[1];
  const clean = heading?.replace(/[*_`[\]]/g, '').trim();
  if (clean && clean.length >= 3) return clean.slice(0, 120);
  const u = new URL(url);
  return `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 120);
}

/** A delete request waits this long for the user's yes. */
export const DELETE_CONFIRM_MS = 5 * 60 * 1000;

export function createDocsTool(
  store: DocMemory,
  scopeOf: () => string,
  opts: {
    now?: () => number;
    /** Importar carpetas del PC: solo en el chat privado del dueño (y la Gate pregunta cada vez). */
    folderAllowed?: () => boolean;
    /** Descarga de una web pública (por defecto `fetchPage`, el mismo filtro SSRF del tool fetch). */
    fetchPage?: (url: string, o: { format: 'markdown'; maxChars: number }) => Promise<FetchedPage>;
  } = {},
): AgentTool<ReturnType<typeof DocsParams>> {
  const now = opts.now ?? Date.now;
  const getPage =
    opts.fetchPage ??
    (async (url: string, o: { format: 'markdown'; maxChars: number }) =>
      (await import('./fetch.js')).fetchPage(url, o));
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
      'action=save_url (with url) keeps a public web page on the shelf when the user asks',
      '(«guarda esta web en mis documentos»); saving the same page again refreshes it.',
      'action=import_folder (with path) keeps the documents of a PC folder the user named',
      '(PDF, Word, Excel, text…, up to 200 files); importing it again refreshes them.',
      'Answer from the quoted passages and name the document and date. If nothing',
      'matches, say you did not FIND it - never that it does not exist: the search',
      'needs every word to appear, and a long document may only be partially indexed.',
    ].join('\n'),
    parameters: DocsParams(),
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const scope = scopeOf();
      const { read } = memoryScopesFor(scope);
      switch (args.action) {
        case 'search': {
          const query = String(args.query ?? '').trim();
          if (!query) throw new Error('la acción search necesita query');
          const hits = store.searchIn(read, query);
          if (!hits.length) {
            return {
              content: [
                {
                  type: 'text',
                  // "No encontrado", nunca "no existe": el AND de términos y la
                  // indexación parcial de documentos largos pueden dejar fuera
                  // algo que sí llegó.
                  text: `No he encontrado nada con esas palabras (${coverage(store.statsIn(read))}). Puede estar escrito de otra forma, no haber llegado nunca, o ser de un tipo que no se pudo leer.`,
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
                      `- ${h.title} (${kindLabel(h.mimeType)}, ${localDay(new Date(h.at))}${h.truncated ? ', indexado parcial' : ''}): …${h.snippet}…`,
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
          const item = store.listIn(read, 1000).find((d) => d.docId === id);
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
          const ok = store.removeIn(read, id);
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
        case 'save_url': {
          const url = normalizeSavedUrl(String(args.url ?? ''));
          if (!url) throw new Error('la acción save_url necesita una url http(s) completa');
          let page: FetchedPage;
          try {
            page = await getPage(url, { format: 'markdown', maxChars: SAVE_URL_MAX_CHARS });
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No he podido abrir esa web, así que no he guardado nada (${err instanceof Error ? err.message : String(err)}).`,
                },
              ],
              details: { saved: false },
            };
          }
          // fetchPage marca el recorte con una línea final; en la estantería sobra.
          const text = page.text.replace(/\n\n\[truncated at [^\]]+\]\s*$/, '');
          const title = savedPageTitle(url, text);
          const indexed = await store.index(
            scope,
            {
              fileId: `url:${url}`,
              name: `${title} (${new URL(url).hostname.replace(/^www\./, '')})`,
              mimeType: 'text/markdown',
            },
            Buffer.from(text, 'utf8'),
          );
          if (!indexed) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'La web no tiene texto que guardar (puede ser solo imágenes o necesitar iniciar sesión); no he guardado nada.',
                },
              ],
              details: { saved: false },
            };
          }
          const partial = indexed.truncated || page.truncated;
          return {
            content: [
              {
                type: 'text',
                text: `Guardada en tus documentos: "${indexed.title}" [${indexed.docId}], ${indexed.chunks} ${indexed.chunks === 1 ? 'fragmento' : 'fragmentos'}${partial ? ' (solo una parte: es muy larga)' : ''}. Ya se puede buscar con action=search; si la guardas otra vez, se actualiza.`,
              },
            ],
            details: { saved: true, docId: indexed.docId, truncated: partial },
          };
        }
        case 'import_folder': {
          if (!opts.folderAllowed?.()) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'Guardar carpetas del PC solo se puede desde el chat privado del dueño.',
                },
              ],
              details: { saved: 0 },
            };
          }
          const raw = String(args.path ?? '').trim();
          if (!raw) throw new Error('la acción import_folder necesita path (la carpeta)');
          const root = resolve(raw.replace(/^~(?=$|[\\/])/, homedir()));
          const st = await lstat(root).catch(() => null);
          if (!st?.isDirectory()) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No encuentro la carpeta «${raw}» en el PC; no he guardado nada.`,
                },
              ],
              details: { saved: 0 },
            };
          }
          const { files, skipped, more } = await listFolder(root);
          let saved = 0;
          let partial = 0;
          const failed: string[] = [];
          for (const f of files) {
            try {
              const r = await store.index(
                scope,
                // Windows no distingue mayúsculas: la misma ruta escrita distinta es el mismo fichero.
                {
                  fileId: `file:${process.platform === 'win32' ? f.abs.toLowerCase() : f.abs}`,
                  name: f.rel,
                  mimeType: f.mime,
                },
                await readFile(f.abs),
              );
              if (r) {
                saved++;
                if (r.truncated) partial++;
              } else failed.push(f.rel);
            } catch {
              failed.push(f.rel);
            }
          }
          const lines = [
            saved
              ? `Guardados ${saved} ${saved === 1 ? 'documento' : 'documentos'} de «${raw}» en tus documentos${partial ? ` (${partial} solo en parte, por largos)` : ''}. Ya se pueden buscar; si la importas otra vez, se actualizan.`
              : `No he guardado nada de «${raw}»: no hay documentos que sepa leer (PDF, Word, Excel, PowerPoint, texto…).`,
          ];
          if (failed.length)
            lines.push(
              `Sin texto o no se pudieron leer (${failed.length}): ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? '…' : ''}.`,
            );
          if (skipped) lines.push(`${skipped} de otro tipo o de más de 20 MB, sin guardar.`);
          if (more)
            lines.push(
              `Paré en ${FOLDER_MAX_FILES} ficheros: para el resto, importa sus subcarpetas por separado.`,
            );
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            details: { saved, failed: failed.length, skipped, more },
          };
        }
        case 'list': {
          const docs = store.listIn(read);
          return {
            content: [
              {
                type: 'text',
                text: docs.length
                  ? docs
                      .map(
                        (d) =>
                          `- [${d.docId}] ${d.title} (${kindLabel(d.mimeType)}, ${d.chunks} ${d.chunks === 1 ? 'fragmento' : 'fragmentos'}${d.truncated ? ', indexado parcial' : ''})`,
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

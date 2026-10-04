import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { type ConvertResult, pdfToEpub } from '../books/convert.js';
import { isKindleAddress, type KindleDeps, safeFilename, sendToKindle } from '../books/kindle.js';
import { downloadBook, type Fetcher, getJson as netGetJson } from '../books/net.js';
import {
  type BookHit,
  describeHit,
  type GetJson,
  isSpanish,
  pickFile,
  resolveArchiveItem,
  searchArchive,
  searchGutenberg,
  searchOpenLibrary,
  searchWikisource,
} from '../books/sources.js';
import { log } from '../log.js';

/** Where a Wikisource hit is read from. Kept next to the search so they cannot drift. */
const WIKISOURCE_BASE = 'https://es.wikisource.org/wiki';

/**
 * "Búscame este libro y mándamelo": free and public-domain books only.
 *
 * search -> get (download EPUB, or PDF converted to EPUB when a converter exists) ->
 * deliver to Telegram and/or the user's Kindle by email. The model passes an id from a
 * search result, never a URL, and never an email recipient.
 */
export interface BookToolDeps {
  sendDocument: (bytes: Buffer, filename: string, caption: string) => Promise<boolean>;
  kindle: Pick<KindleDeps, 'getAddress' | 'loadAccount' | 'send' | 'requireApproval'>;
  saveKindleAddress: (address: string) => Promise<void>;
  getJson?: GetJson;
  fetcher?: Fetcher;
  convert?: (pdf: Buffer, title: string) => Promise<ConvertResult>;
}

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('search'),
    Type.Literal('get'),
    Type.Literal('set_kindle'),
    Type.Literal('get_url'),
  ]),
  query: Type.Optional(Type.String({ description: 'For search: title and/or author.' })),
  language: Type.Optional(
    Type.String({
      description:
        'For search: ISO code of the wanted language. Defaults to es (Spanish only). Pass "any" only if the user asks for another language.',
    }),
  ),
  id: Type.Optional(
    Type.String({
      description: 'For get: the id of a search result, e.g. gutenberg:2000 or openlibrary:foo.',
    }),
  ),
  url: Type.Optional(
    Type.String({
      description:
        'For get_url: a direct https link to an EPUB or PDF the user gave you. Public addresses only.',
    }),
  ),
  title: Type.Optional(Type.String({ description: 'For get_url: the title, for the filename.' })),
  deliver: Type.Optional(
    Type.Union([Type.Literal('telegram'), Type.Literal('kindle'), Type.Literal('both')], {
      description: 'For get: where to send it. Default telegram.',
    }),
  ),
  address: Type.Optional(Type.String({ description: 'For set_kindle: the @kindle.com address.' })),
});

function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

export function createBookTool(deps: BookToolDeps): AgentTool<typeof Params> {
  const getJson: GetJson = deps.getJson ?? ((u) => netGetJson(u, deps.fetcher));
  const convert = deps.convert ?? ((pdf: Buffer, title: string) => pdfToEpub(pdf, title));

  async function lookup(id: string): Promise<BookHit> {
    const [source, rest] = id.split(':', 2);
    if (source === 'gutenberg' && rest && /^\d+$/.test(rest)) {
      const hits = await searchGutenberg('', async () => ({
        results: [await getJson(`https://gutendex.com/books/${rest}`)],
      }));
      const hit = hits[0];
      if (!hit) throw new Error('Gutenberg no lo da como dominio público con EPUB o PDF');
      return hit;
    }
    if (source === 'archive' && rest) {
      const item = await resolveArchiveItem(rest, getJson);
      return { source: 'archive', id: rest, language: '', ...item };
    }
    if (source === 'openlibrary' && rest) {
      // Open Library is an index over the Internet Archive, so the files come from
      // there and pass the same NOT_IN_COPYRIGHT check.
      const item = await resolveArchiveItem(rest, getJson);
      return { source: 'openlibrary', id: rest, language: 'spa', ...item };
    }
    if (source === 'wikisource' && rest) {
      return {
        source: 'wikisource',
        id: rest,
        title: rest,
        authors: [],
        language: 'spa',
        files: [{ kind: 'epub', url: `${WIKISOURCE_BASE}/${encodeURIComponent(rest)}` }],
      };
    }
    throw new Error(
      'id no válido: usa uno de la búsqueda (gutenberg:NUM, archive:ID, openlibrary:ID o wikisource:Título)',
    );
  }

  /**
   * Convert a PDF to EPUB when a converter is there, then deliver.
   *
   * The user asked for EPUB specifically, so the conversion is attempted for any PDF
   * with a text layer. A scan is the one case left as a PDF, and it says so rather than
   * shipping a file full of empty pages that pretends to be a book.
   */
  async function deliver(
    title: string,
    dl: { bytes: Buffer; kind: 'epub' | 'pdf' },
    scanned = false,
    deliverTo?: string,
  ): Promise<ReturnType<typeof ok>> {
    const notes: string[] = [];
    let bytes = dl.bytes;
    let kind = dl.kind;
    if (kind === 'pdf') {
      if (scanned) {
        notes.push(
          'es un escaneo sin capa de texto: lo dejo en PDF, porque un EPUB de eso saldría vacío',
        );
      } else {
        const c = await convert(bytes, title);
        if (c.ok) {
          bytes = c.epub;
          kind = 'epub';
          notes.push('convertido de PDF a EPUB con Calibre');
        } else {
          notes.push(c.message);
        }
      }
    }
    const filename = safeFilename(title, kind);
    const where = deliverTo ?? 'telegram';
    const out: string[] = [];
    if (where === 'telegram' || where === 'both') {
      const sent = await deps.sendDocument(bytes, filename, title);
      out.push(sent ? `Enviado a este chat (${filename}).` : 'No he podido enviarlo al chat.');
    }
    if (where === 'kindle' || where === 'both') {
      const r = await sendToKindle(
        { ...deps.kindle, requireApproval: deps.kindle.requireApproval },
        { title, bytes, kind },
      );
      out.push(
        {
          sent: `Enviado por correo a ${r.status === 'sent' ? r.to : ''}. Amazon lo entrega solo si el remitente está en tus correos aprobados.`,
          declined: 'No enviado al Kindle: no lo has aprobado.',
          'no-address': 'Falta tu dirección de Kindle (@kindle.com). Pásamela y la guardo.',
          'no-mail-account':
            'BLOQUEO: no hay correo configurado para enviar. Te lo he dejado en el chat; puedes reenviarlo a tu Kindle desde ahí o configurar un correo.',
          error: `No he podido enviarlo por correo: ${r.status === 'error' ? r.message : ''}`,
        }[r.status],
      );
    }
    log.info('book delivered', { kind, where, converter: notes.length > 0 });
    return ok(
      [`${title}: ${kind.toUpperCase()}.`, ...out, ...notes.map((n) => `Nota: ${n}.`)].join('\n'),
      { kind, delivered: where },
    );
  }

  return {
    name: 'book',
    label: 'Libros',
    description: [
      'Find a FREE or public-domain book and deliver it as EPUB to this chat and/or to the',
      "user's Kindle by email.",
      'Sources: Project Gutenberg, Internet Archive public-domain items, Open Library and the',
      'Spanish Wikisource. Searches are Spanish-only unless the user asks for another language;',
      'if a book exists only in another language, say so instead of handing it over.',
      'Use action=search with title/author, show the user the options, then action=get with the',
      'chosen id. A PDF is converted to EPUB with Calibre; only a scan without a text layer stays',
      'a PDF, and the result says so. If the user sends you a direct link, use action=get_url.',
      'Recent or copyrighted books are NOT available: say so plainly and never look for pirated',
      "copies. Kindle delivery needs the user's @kindle.com address (action=set_kindle) and",
      'a configured mailbox; if either is missing say what is missing. Never claim a Kindle',
      'received it: Amazon only accepts mail from approved senders, so say "enviado".',
    ].join(' '),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      switch (args.action) {
        case 'search': {
          const q = (args.query ?? '').trim();
          if (!q) throw new Error('la búsqueda necesita título o autor');
          // Spanish unless the user asked for something else. Every catalogue is asked in
          // the same language, so a result in another language cannot slip in through a
          // source that ignores the filter.
          const wanted = (args.language ?? 'es').trim() || 'es';
          const filter = wanted.toLowerCase() === 'any' ? undefined : wanted;
          const results = await Promise.allSettled([
            searchGutenberg(q, getJson, { language: filter, limit: 5 }),
            searchOpenLibrary(q, getJson, { language: filter, limit: 5 }),
            searchArchive(q, getJson, { limit: 4 }),
            searchWikisource(q, getJson, { limit: 4 }),
          ]);
          const collected = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
          // Belt and braces: a catalogue that ignored the language filter must not be
          // able to hand back an English edition under a Spanish request.
          const spanish = filter ? collected.filter((h) => isSpanish(h.language)) : collected;
          const down = results.filter((r) => r.status === 'rejected').length;
          if (!spanish.length) {
            if (down === results.length) {
              return ok('No he podido consultar las fuentes ahora mismo. Inténtalo más tarde.', {
                hits: 0,
                sourcesDown: down,
              });
            }
            const others = [...new Set(collected.map((h) => h.language || '?'))].join(', ');
            return ok(
              collected.length
                ? `He encontrado "${q}", pero solo en otros idiomas (${others}). Como pediste solo castellano, no te los propongo; si quieres alguno igualmente, dímelo.`
                : `No he encontrado "${q}" como libro libre o de dominio público en castellano. Si es reciente, tiene derechos de autor y no puedo conseguirlo.`,
              { hits: 0, onlyOtherLanguages: collected.length > 0 },
            );
          }
          return ok(
            [
              ...spanish.map((h, i) => describeHit(h, i + 1)),
              down ? '(Una de las fuentes no respondió.)' : '',
            ]
              .filter(Boolean)
              .join('\n'),
            { hits: spanish.length, sourcesDown: down },
          );
        }

        case 'set_kindle': {
          const address = (args.address ?? '').trim();
          if (!isKindleAddress(address)) {
            throw new Error('esa dirección no parece de Kindle (termina en @kindle.com)');
          }
          const approved = await deps.kindle.requireApproval(
            'book:set_kindle',
            `Guardar ${address} como tu dirección de Kindle`,
          );
          if (!approved) return ok('No guardada: no lo has aprobado.', { saved: false });
          await deps.saveKindleAddress(address);
          return ok(
            `Guardada. Para que Amazon acepte los envíos, añade el correo remitente a "Correos electrónicos aprobados" en tu cuenta de Amazon (Contenido y dispositivos > Preferencias).`,
            { saved: true },
          );
        }

        case 'get': {
          const hit = await lookup((args.id ?? '').trim());
          const file = pickFile(hit.files);
          if (!file) throw new Error('no hay EPUB ni PDF descargable de ese libro');
          return deliver(
            hit.title,
            await downloadBook(file.url, deps.fetcher),
            file.scanned,
            args.deliver,
          );
        }

        case 'get_url': {
          const url = (args.url ?? '').trim();
          if (!url) throw new Error('esta acción necesita url= con el enlace que te ha pasado');
          const title = (args.title ?? '').trim() || 'libro';
          // direct: the user supplied this link, so it is checked for being a public
          // https address instead of against the catalogue allow list. The bytes still
          // have to sniff as a real EPUB or PDF, and the SSRF guard still applies.
          return deliver(
            title,
            await downloadBook(url, deps.fetcher, undefined, { direct: true }),
            false,
            args.deliver,
          );
        }

        default:
          throw new Error(`acción desconocida: ${String(args.action)}`);
      }
    },
  };
}

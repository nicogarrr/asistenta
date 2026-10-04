import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { type ConvertResult, pdfToEpub } from '../books/convert.js';
import { isKindleAddress, type KindleDeps, safeFilename, sendToKindle } from '../books/kindle.js';
import { downloadBook, type Fetcher, getJson as netGetJson } from '../books/net.js';
import {
  type BookHit,
  describeHit,
  type GetJson,
  pickFile,
  resolveArchiveItem,
  searchArchive,
  searchGutenberg,
} from '../books/sources.js';
import { log } from '../log.js';

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
  action: Type.Union([Type.Literal('search'), Type.Literal('get'), Type.Literal('set_kindle')]),
  query: Type.Optional(Type.String({ description: 'For search: title and/or author.' })),
  language: Type.Optional(
    Type.String({ description: 'For search: ISO code like es, en, fr (Gutenberg only).' }),
  ),
  id: Type.Optional(
    Type.String({ description: 'For get: the id of a search result, e.g. gutenberg:2000.' }),
  ),
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
    throw new Error('id no válido: usa uno de la búsqueda (gutenberg:NUM o archive:ID)');
  }

  return {
    name: 'book',
    label: 'Libros',
    description: [
      'Find a FREE or public-domain book (Project Gutenberg, Internet Archive public domain)',
      "and deliver it as EPUB: to this chat and/or to the user's Kindle by email.",
      'Use action=search with title/author, show the user the options, then action=get with',
      'the chosen id. A PDF is converted to EPUB when possible; a scanned PDF is kept as PDF.',
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
          const [g, a] = await Promise.allSettled([
            searchGutenberg(q, getJson, { language: args.language, limit: 5 }),
            searchArchive(q, getJson, { limit: 4 }),
          ]);
          const hits = [
            ...(g.status === 'fulfilled' ? g.value : []),
            ...(a.status === 'fulfilled' ? a.value : []),
          ];
          const down = [g, a].filter((r) => r.status === 'rejected').length;
          if (!hits.length) {
            return ok(
              down === 2
                ? 'No he podido consultar las fuentes ahora mismo. Inténtalo más tarde.'
                : `No he encontrado "${q}" como libro libre o de dominio público. Si es reciente, tiene derechos de autor y no puedo conseguirlo.`,
              { hits: 0 },
            );
          }
          return ok(
            [
              ...hits.map((h, i) => describeHit(h, i + 1)),
              down ? '(Una de las fuentes no respondió.)' : '',
            ]
              .filter(Boolean)
              .join('\n'),
            { hits: hits.length },
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
          const dl = await downloadBook(file.url, deps.fetcher);
          const notes: string[] = [];
          let bytes = dl.bytes;
          let kind = dl.kind;
          if (kind === 'pdf') {
            if (file.scanned) {
              notes.push(
                'es un escaneo (sin texto): lo dejo en PDF porque convertirlo a EPUB no daría texto',
              );
            } else {
              const c = await convert(bytes, hit.title);
              if (c.ok) {
                bytes = c.epub;
                kind = 'epub';
                notes.push('convertido de PDF a EPUB');
              } else {
                notes.push(c.message);
              }
            }
          }
          const filename = safeFilename(hit.title, kind);
          const where = args.deliver ?? 'telegram';
          const out: string[] = [];
          if (where === 'telegram' || where === 'both') {
            const sent = await deps.sendDocument(bytes, filename, hit.title);
            out.push(
              sent ? `Enviado a este chat (${filename}).` : 'No he podido enviarlo al chat.',
            );
          }
          if (where === 'kindle' || where === 'both') {
            const r = await sendToKindle(
              { ...deps.kindle, requireApproval: deps.kindle.requireApproval },
              { title: hit.title, bytes, kind },
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
          log.info('book delivered', { source: hit.source, kind, where });
          return ok(
            [
              `${hit.title}: ${kind.toUpperCase()}.`,
              ...out,
              ...notes.map((n) => `Nota: ${n}.`),
            ].join('\n'),
            {
              source: hit.source,
              kind,
              delivered: where,
            },
          );
        }

        default:
          throw new Error(`acción desconocida: ${String(args.action)}`);
      }
    },
  };
}

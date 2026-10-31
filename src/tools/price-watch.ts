import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import { eur, type PageWatch, type PageWatchStore } from '../watch/pages.js';

/**
 * «Avísame si baja de 400 € el precio de esto» como herramienta de chat.
 *
 * Hasta ahora solo había /vigila (comando): el modelo no
 * tenía forma de crear una vigilancia y acababa montando un objetivo que hacía fetch
 * cada hora gastando modelo en cada lectura. Esta herramienta escribe en el MISMO
 * registro que /vigila (PageWatchStore), así que /vigilando, /precio y
 * /dejar_de_vigilar la ven, y las lecturas las hace el bucle de vigilancia sin LLM.
 *
 * - El ámbito (chat) lo pone quien llama, nunca el modelo.
 * - Solo enlaces públicos http(s) (mismo control SSRF que fetch).
 * - Crear una vigilancia es una salida a la red: la puerta de exfiltración
 *   (src/egress-taint.ts) la trata como un fetch a esa URL.
 */

const Params = Type.Object({
  action: Type.Union([Type.Literal('add'), Type.Literal('list'), Type.Literal('remove')]),
  url: Type.Optional(
    Type.String({ description: 'add: public http(s) link to the product page to watch.' }),
  ),
  target_eur: Type.Optional(
    Type.Number({
      description: 'add: alert when the price drops to or below this amount in euros (e.g. 399.9).',
    }),
  ),
  drop_pct: Type.Optional(
    Type.Number({ description: 'add: alert when the price drops this percent (1-95).' }),
  ),
  keyword: Type.Optional(
    Type.String({
      description: 'add: alert when this word appears or disappears (e.g. "agotado").',
    }),
  ),
  label: Type.Optional(Type.String({ description: 'add: short name to show in alerts.' })),
  id: Type.Optional(Type.String({ description: 'remove: the watch id (or its first letters).' })),
});

/**
 * Los avisos propios del registro («ya vigilas 20 páginas…», el porcentaje) ya son claros
 * y se dicen tal cual. Un fallo de la base de datos o del disco (SQLite, EPERM, ENOSPC)
 * llegaba crudo al chat: ahora una frase llana y el crudo solo al log.
 */
function addFailReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = String((err as { code?: unknown } | null)?.code ?? '');
  if (!/SQLITE|^E[A-Z]+$/.test(code) && !/SQLITE|database|disk|EPERM|EACCES|ENOSPC/i.test(raw))
    return raw.slice(0, 200);
  log.warn('vigilar_precio: no se pudo guardar', { err: raw.slice(0, 300), code });
  if (/ENOSPC|SQLITE_FULL|disk is full|database or disk is full/i.test(`${code} ${raw}`))
    return 'el disco del PC está lleno. Libera espacio y vuelve a pedírmelo.';
  return 'no pude guardarla en el PC ahora mismo. Prueba otra vez en un rato.';
}

export interface PriceWatchToolDeps {
  watches: Pick<PageWatchStore, 'add' | 'list' | 'remove'>;
  /** Chat al que pertenecen las vigilancias (el mismo que usa /vigila). */
  scopeOf: () => string;
  /** URL pública http(s) que resuelve a IPs públicas (isFetchableResolved). */
  isFetchable: (url: string) => Promise<boolean>;
}

function reply(text: string, isError = false): AgentToolResult<Record<string, never>> {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

function describe(w: PageWatch): string {
  const extra = [
    w.keyword ? `palabra "${w.keyword}"` : '',
    w.targetCents !== null ? `objetivo ${eur(w.targetCents)}` : '',
    w.dropPct !== null ? `bajada ${w.dropPct} %` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `${w.id} · ${w.label || w.url}${extra ? ` (${extra})` : ''}`;
}

export function createPriceWatchTool(deps: PriceWatchToolDeps): AgentTool<typeof Params> {
  return {
    name: 'vigilar_precio',
    label: 'Vigilar precio',
    description: [
      'Watch a public product page and alert the user in this chat when the price changes,',
      'drops to target_eur, drops drop_pct percent, or a keyword appears/disappears.',
      'Checks run in the background every ~2 h WITHOUT using the model: prefer this over a',
      'goal or a reminder for "avísame si baja de X". action=add (url + optional target_eur,',
      'drop_pct, keyword, label), action=list, action=remove (id). Adding the same url again',
      'replaces target_eur and drop_pct. Never claim a watch exists unless this tool said so.',
    ].join('\n'),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const scope = deps.scopeOf();
      if (args.action === 'list') {
        const rows = deps.watches.list(scope);
        if (rows.length === 0) return reply('No hay vigilancias de precio en este chat.');
        return reply(rows.map((w) => `- ${describe(w)}`).join('\n'));
      }
      if (args.action === 'remove') {
        const id = String(args.id ?? '').trim();
        if (!id) return reply('remove necesita id (mira action=list).', true);
        return deps.watches.remove(scope, id)
          ? reply(`Quitada la vigilancia ${id}.`)
          : reply(`No encuentro ninguna vigilancia con id "${id}" en este chat.`, true);
      }
      const url = String(args.url ?? '').trim();
      if (!url) return reply('add necesita url (enlace público http/https).', true);
      if (!(await deps.isFetchable(url))) {
        return reply('Solo puedo vigilar enlaces públicos http(s).', true);
      }
      let targetCents: number | undefined;
      if (args.target_eur !== undefined) {
        const t = Number(args.target_eur);
        if (!Number.isFinite(t) || t <= 0 || t > 1_000_000) {
          return reply('target_eur tiene que ser un importe en euros mayor que 0.', true);
        }
        targetCents = Math.round(t * 100);
      }
      let dropPct: number | undefined;
      if (args.drop_pct !== undefined) {
        const p = Number(args.drop_pct);
        if (!Number.isFinite(p) || p < 1 || p > 95) {
          return reply('drop_pct tiene que estar entre 1 y 95.', true);
        }
        dropPct = p;
      }
      const label = String(args.label ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      try {
        const w = deps.watches.add(scope, url, label, String(args.keyword ?? ''), {
          targetCents,
          dropPct,
        });
        return reply(
          `Vigilancia creada: ${describe(w)}. Miro cada 2 horas y aviso en este chat; /vigilando la lista, /dejar_de_vigilar ${w.id} la quita.`,
        );
      } catch (err) {
        return reply(`No he podido crear la vigilancia: ${addFailReason(err)}`, true);
      }
    },
  };
}

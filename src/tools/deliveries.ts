import type { DatabaseSync } from 'node:sqlite';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  activeDeliveries,
  type Delivery,
  ingestDeliveries,
  markDeliveryCollected,
} from '../mail/deliveries.js';
import { deliveriesText } from '../mail/deliveries-text.js';
import type { MailMessage } from '../mail/types.js';

const Params = Type.Object({
  recogido: Type.Optional(
    Type.String({
      description:
        'Only when the owner says he already picked up or received a parcel («ya he recogido el de InPost»): its tracking number, carrier or a word of it. Marks it delivered so it stops showing. After a «¿Cuál?» pass his answer as said («el segundo», «el último»). Empty for «where is my parcel».',
    }),
  ),
});
const LOOKBACK_MS = 14 * 86_400_000;

/** The last «¿Cuál?» list, so «el segundo» or «el último» picks from it (30 min). */
const lastChoices = new WeakMap<DatabaseSync, { keys: string[]; at: number }>();
const CHOICES_TTL_MS = 30 * 60_000;
const ORDINALS: Record<string, number> = {
  primer: 0,
  primero: 0,
  primera: 0,
  segundo: 1,
  segunda: 1,
  tercer: 2,
  tercero: 2,
  tercera: 2,
  cuarto: 3,
  cuarta: 3,
};

/** «el segundo», «la última»: a place in the list just shown, or undefined. */
function chosenKey(db: DatabaseSync, said: string, now: number): string | undefined {
  const word = /^(?:(?:el|la|lo)\s+)?([a-z]+)$/.exec(
    said
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[.,!?]/g, '')
      .trim(),
  )?.[1];
  const shown = lastChoices.get(db);
  if (!word || !shown || now - shown.at > CHOICES_TTL_MS) return undefined;
  if (word === 'ultimo' || word === 'ultima') return shown.keys.at(-1);
  const at = ORDINALS[word];
  return at === undefined ? undefined : shown.keys[at];
}

const choiceLabel = (d: Delivery): string =>
  `${d.carrier}${d.tracking ? ` (${d.tracking})` : ` («${d.title.slice(0, 60)}»)`}`;

export interface DeliveriesToolDeps {
  db: DatabaseSync;
  /** Correos recientes del buzón ya configurado; null si no hay correo configurado. */
  recentMail?: (sinceMs: number) => Promise<MailMessage[] | null>;
  timeZone?: string;
  now?: () => number;
}

/**
 * «¿Dónde está mi pedido?»: los envíos en marcha según los correos de la tienda y la
 * transportista. Solo lectura: lee el correo propio, no entra en webs de transportistas.
 */
export function createDeliveriesTool(deps: DeliveriesToolDeps): AgentTool<typeof Params> {
  return {
    name: 'repartos',
    label: 'Repartos',
    description:
      "Where the owner's parcels are, from shipping/order emails already in his mailbox (Amazon, Correos, SEUR, MRW, GLS, DHL, UPS, InPost, Paack…): carrier, tracking number and last status (incl. ready for pickup at a locker/point). Use for «¿dónde está mi pedido?», «¿llega hoy el paquete?», «¿tengo algo para recoger?». Read-only; never opens carrier websites.",
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      const now = deps.now?.() ?? Date.now();
      if (args.recogido !== undefined) {
        const r = markDeliveryCollected(
          deps.db,
          args.recogido,
          now,
          chosenKey(deps.db, args.recogido, now),
        );
        if ('matches' in r && r.matches.length > 1)
          lastChoices.set(deps.db, { keys: r.matches.map((d) => d.key), at: now });
        const text =
          'done' in r
            ? `Hecho, quito ${r.done.carrier}${r.done.tracking ? ` (${r.done.tracking})` : ''} de la lista: ya lo tienes.`
            : r.matches.length > 1
              ? `¿Cuál? ${r.matches.map(choiceLabel).join(', ')}.`
              : 'No encuentro ese paquete entre los que están en camino.';
        return { content: [{ type: 'text', text }], details: {} };
      }
      let note = '';
      if (deps.recentMail) {
        try {
          const msgs = await deps.recentMail(now - LOOKBACK_MS);
          if (msgs === null)
            note = 'No tengo tu correo configurado, así que no puedo ver los envíos.';
          else ingestDeliveries(deps.db, msgs, now);
        } catch {
          note = 'Ahora no he podido mirar el correo; te digo lo último que vi.';
        }
      }
      const list = activeDeliveries(deps.db, now);
      const text =
        note && list.length === 0
          ? note
          : [deliveriesText(list, deps.timeZone), note].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}

import type { DatabaseSync } from 'node:sqlite';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { activeDeliveries, ingestDeliveries } from '../mail/deliveries.js';
import { deliveriesText } from '../mail/deliveries-text.js';
import type { MailMessage } from '../mail/types.js';

const Params = Type.Object({});
const LOOKBACK_MS = 14 * 86_400_000;

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
    execute: async () => {
      const now = deps.now?.() ?? Date.now();
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

import type { Account } from './store.js';

/**
 * Altas a medias: cuánto llevan así. No se borran solas nunca: pasados unos días se
 * le ofrece al dueño descartarlas y es él quien dice que sí («descarta lo de X»).
 */
export const OLD_PENDING_DAYS = 7;

const DAY_MS = 86_400_000;

/** Días enteros desde que empezó el alta, o null si no se sabe (fecha vacía o rota). */
export function pendingDays(a: Account, now: number = Date.now()): number | null {
  const t = Date.parse(a.created);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/** «de hoy», «de ayer», «de hace 12 días»; vacío si no se sabe. */
export function pendingAge(a: Account, now: number = Date.now()): string {
  const d = pendingDays(a, now);
  if (d === null) return '';
  return d === 0 ? 'de hoy' : d === 1 ? 'de ayer' : `de hace ${d} días`;
}

/** Las altas a medias que ya llevan una semana o más. */
export function oldPending(all: Account[], now: number = Date.now()): Account[] {
  return all.filter(
    (a) => a.status === 'pendiente' && (pendingDays(a, now) ?? 0) >= OLD_PENDING_DAYS,
  );
}

/**
 * La oferta de descartar las viejas (nunca se borran sin el sí del dueño), o vacío.
 * En la consola (`cli`) se le dice que lo pida en el chat, que es donde se descarta.
 */
export function oldPendingOffer(all: Account[], now: number = Date.now(), cli = false): string {
  const old = oldPending(all, now);
  const first = old[0];
  if (!first) return '';
  const ask = cli ? 'pídeme en el chat' : 'dime';
  return old.length === 1
    ? `El alta de ${first.domain} lleva a medias más de ${OLD_PENDING_DAYS} días: si ya no la quieres, ${ask} «descarta lo de ${first.domain}» y la quito.`
    : `Hay ${old.length} altas a medias de hace más de ${OLD_PENDING_DAYS} días (${old.map((a) => a.domain).join(', ')}): si ya no las quieres, ${ask} cuáles descarto.`;
}

import type { DatabaseSync } from 'node:sqlite';
import type { MailMessage } from './types.js';

/**
 * Seguimiento de repartos leyendo SOLO los correos que ya lee el lector de correo: pedido
 * confirmado, enviado, en reparto, entregado o incidencia. Sin entrar en la web de la
 * transportista ni guardar el correo: por envío se guarda transportista, número de
 * seguimiento, pedido, un título corto y el último estado.
 */

export type DeliveryStatus =
  | 'confirmado'
  | 'enviado'
  | 'en_reparto'
  | 'para_recoger'
  | 'entregado'
  | 'incidencia'
  | 'retrasado';

const ALERT_STATUSES: readonly DeliveryStatus[] = [
  'en_reparto',
  'para_recoger',
  'entregado',
  'incidencia',
  'retrasado',
];
/** Un cambio más viejo que esto (p. ej. al leer el buzón por primera vez) no avisa. */
export const DELIVERY_ALERT_MAX_AGE_MS = 2 * 86_400_000;
const DELIVERED_KEEP_MS = 2 * 86_400_000;
const STALE_MS = 30 * 86_400_000;

const CARRIERS: ReadonlyArray<[string, RegExp]> = [
  ['Amazon', /amazon\.|\bamazon\b/i],
  ['AliExpress', /aliexpress/i],
  ['Correos Express', /correos ?express/i],
  ['Correos', /\bcorreos\b/i],
  ['SEUR', /\bseur\b/i],
  ['MRW', /\bmrw\b/i],
  ['GLS', /\bgls\b/i],
  ['DHL', /\bdhl\b/i],
  ['UPS', /\bups\b/i],
  ['Packlink', /packlink/i],
  ['Nacex', /\bnacex\b/i],
  ['CTT', /\bctt\b/i],
  ['FedEx', /fedex/i],
  ['InPost', /inpost/i],
  ['Paack', /\bpaack\b/i],
  ['Celeritas', /celeritas/i],
  ['Zeleris', /zeleris/i],
  ['Envialia', /envialia/i],
  ['Tipsa', /\btipsa\b|tip-sa\./i],
  ['Mondial Relay', /mondial ?relay/i],
  ['Vinted Go', /vinted ?go\b/i],
];

const STATUS_RULES: ReadonlyArray<[DeliveryStatus, RegExp]> = [
  [
    'incidencia',
    /incidencia|no (?:hemos )?podido entregar|intento de entrega|entrega fallida|no ha sido posible entregar|estabas ausente|en aduanas?|retenido|devuelto al remitente|delivery exception|failed delivery|delivery attempt/i,
  ],
  [
    'retrasado',
    // «Lleva un retraso», «se retrasa», «delayed»: sin incidencia grave ni estado nuevo
    // el correo del retraso no contaba y el paquete se quedaba «enviado» para siempre.
    // Solo formas que afirman el retraso: «puedes retrasar la entrega» o «sin retrasos»
    // no dicen que el paquete vaya tarde.
    /(?:un|una|el|la|con)\s+(?:retrasos?|demoras?)\b|se retras(?:a|an|ar[aá]|[óo])(?=\s|$|[.,;:!?])|retrasad[oa]s?\b|\bdelayed\b|(?:a|the)\s+delay\b|m[aá]s tarde de lo previsto/i,
  ],
  [
    'para_recoger',
    /list[oa] para (?:su )?recog(?:er|ida)|disponible para (?:su )?recog(?:er|ida)|(?:ya )?puedes recoger(?:lo|la)?\b|te espera en|ready for (?:pick ?up|collection)|ready to collect|available for (?:pick ?up|collection)/i,
  ],
  [
    'entregado',
    // «aún no ha sido entregado», «pendiente de ser entregado», «will be delivered», «has not
    // been delivered»: dicen lo contrario. Antes se leían como entregado y el paquete
    // desaparecía de los repartos activos sin haber llegado.
    /(?<!(?:\bno|\bnot|n't|\bser|\bser[aá]|\bsea|\bbe)\s+(?:(?:ha|han|se|sido|fue|been|yet|a[uú]n)\s+){0,3})\b(?:entregado|entregada|se ha entregado|delivered|recogido en)\b|ya (?:lo )?tienes/i,
  ],
  [
    'en_reparto',
    /en reparto|saldr[aá] hoy|out for delivery|llega hoy|llegar[aá] hoy|lo recibir[aá]s hoy|en ruta de entrega|se entregar[aá] hoy|ser[aá] entregad[oa] hoy|entrega prevista (?:para )?hoy|arriving today|(?:will|to) be delivered today/i,
  ],
  [
    'enviado',
    /enviado|ha salido|en tr[aá]nsito|en camino|shipped|dispatched|in transit|ya est[aá] de camino/i,
  ],
  [
    'confirmado',
    /pedido confirmado|confirmaci[oó]n (?:de )?(?:tu |su )?pedido|order confirm|gracias por tu (?:pedido|compra)|hemos recibido tu pedido/i,
  ],
];

const TRACKING_PATTERNS: readonly RegExp[] = [
  /(?:seguimiento|tracking|env[ií]o|paquete|localizador|expedici[oó]n)\s*(?:n[.ºo°]*\s*)?[:#]?\s*(?:[A-Za-z]{2,12}\s+)?([A-Z0-9]{8,30})\b/i,
  /\b(1Z[0-9A-Z]{16})\b/,
  /\b([A-Z]{2}\d{9}[A-Z]{2})\b/,
  /\b(P[A-Z0-9]{15,22})\b/,
];

const ORDER_PATTERNS: readonly RegExp[] = [
  /\b(\d{3}-\d{7}-\d{7})\b/,
  /pedido\s*(?:n[.ºo°]*|n[uú]mero)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,24})\b/i,
  /order\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,24})\b/i,
];

export interface ParsedDelivery {
  carrier: string;
  status: DeliveryStatus;
  tracking?: string;
  order?: string;
  title: string;
}

function firstMatch(patterns: readonly RegExp[], text: string): string | undefined {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1] && /\d/.test(m[1])) return m[1].toUpperCase();
  }
  return undefined;
}

function statusOf(text: string): DeliveryStatus | undefined {
  return STATUS_RULES.find(([, re]) => re.test(text))?.[0];
}

/** ¿Es un correo de pedido o envío? Devuelve lo que se puede guardar, o null. */
export function parseDelivery(
  msg: Pick<MailMessage, 'from' | 'subject' | 'text'>,
): ParsedDelivery | null {
  const head = `${msg.from} ${msg.subject}`;
  const body = msg.text.slice(0, 4000);
  const carrier =
    CARRIERS.find(([, re]) => re.test(head))?.[0] ?? CARRIERS.find(([, re]) => re.test(body))?.[0];
  const status = statusOf(msg.subject) ?? statusOf(body);
  if (!status) return null;
  const tracking = firstMatch(TRACKING_PATTERNS, `${msg.subject}\n${body}`);
  const order = firstMatch(ORDER_PATTERNS, `${msg.subject}\n${body}`);
  if (!carrier && !tracking) return null;
  if (!carrier && !/pedido|env[ií]o|paquete|order|package|shipment/i.test(`${msg.subject} ${body}`))
    return null;
  return {
    carrier: carrier ?? 'tienda',
    status,
    ...(tracking ? { tracking } : {}),
    ...(order ? { order } : {}),
    title: msg.subject.replace(/\s+/g, ' ').trim().slice(0, 80),
  };
}

export interface Delivery {
  key: string;
  carrier: string;
  tracking: string | null;
  orderRef: string | null;
  title: string;
  status: DeliveryStatus;
  statusAt: number;
  notified: string | null;
}

export function initDeliveryStore(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS deliveries (
    key TEXT PRIMARY KEY, carrier TEXT NOT NULL, tracking TEXT, order_ref TEXT,
    title TEXT NOT NULL, status TEXT NOT NULL, status_at INTEGER NOT NULL,
    notified TEXT, updated_at INTEGER NOT NULL)`);
  db.exec(
    'CREATE TABLE IF NOT EXISTS delivery_mail_seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)',
  );
}

/** Clave de un envío: seguimiento, si no el pedido, si no transportista + asunto. */
function keyOf(p: ParsedDelivery): string {
  if (p.tracking) return `t:${p.tracking}`;
  if (p.order) return `o:${p.order}`;
  return `s:${p.carrier}:${p.title.toLowerCase()}`;
}

function rowToDelivery(r: Record<string, unknown>): Delivery {
  return {
    key: String(r.key),
    carrier: String(r.carrier),
    tracking: r.tracking == null ? null : String(r.tracking),
    orderRef: r.order_ref == null ? null : String(r.order_ref),
    title: String(r.title),
    status: String(r.status) as DeliveryStatus,
    statusAt: Number(r.status_at),
    notified: r.notified == null ? null : String(r.notified),
  };
}

/** Incorpora los correos leídos; cada correo cuenta una vez. Devuelve cuántos eran de envíos. */
export function ingestDeliveries(
  db: DatabaseSync,
  msgs: readonly MailMessage[],
  now: number,
): number {
  initDeliveryStore(db);
  const seen = db.prepare('SELECT 1 FROM delivery_mail_seen WHERE id = ?');
  const markSeen = db.prepare('INSERT OR IGNORE INTO delivery_mail_seen (id, at) VALUES (?, ?)');
  const byOrder = db.prepare(
    'SELECT * FROM deliveries WHERE order_ref = ? ORDER BY status_at DESC LIMIT 1',
  );
  const get = db.prepare(
    'SELECT * FROM deliveries WHERE key = ? OR (tracking IS NOT NULL AND tracking = ?)',
  );
  let count = 0;
  for (const msg of [...msgs].sort((a, b) => a.at - b.at)) {
    if (seen.get(msg.id)) continue;
    markSeen.run(msg.id, now);
    const p = parseDelivery(msg);
    if (!p) continue;
    count += 1;
    const at = Number.isFinite(msg.at) && msg.at > 0 ? msg.at : now;
    // El correo de envío trae seguimiento y el de confirmación solo el pedido: mismo envío.
    const prev =
      (get.get(keyOf(p), p.tracking ?? null) as Record<string, unknown> | undefined) ??
      (p.order ? (byOrder.get(p.order) as Record<string, unknown> | undefined) : undefined);
    if (!prev) {
      db.prepare(
        'INSERT INTO deliveries (key, carrier, tracking, order_ref, title, status, status_at, notified, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
      ).run(keyOf(p), p.carrier, p.tracking ?? null, p.order ?? null, p.title, p.status, at, now);
      continue;
    }
    const d = rowToDelivery(prev);
    if (at < d.statusAt) continue; // un correo más viejo no pisa el estado
    db.prepare(
      'UPDATE deliveries SET carrier = ?, tracking = ?, order_ref = ?, title = ?, status = ?, status_at = ?, updated_at = ? WHERE key = ?',
    ).run(
      d.carrier === 'tienda' ? p.carrier : d.carrier,
      p.tracking ?? d.tracking,
      p.order ?? d.orderRef,
      d.title,
      p.status,
      at,
      now,
      d.key,
    );
  }
  db.prepare('DELETE FROM delivery_mail_seen WHERE at < ?').run(now - 60 * 86_400_000);
  return count;
}

/** Envíos en marcha (y lo entregado en los dos últimos días), lo más reciente primero. */
export function activeDeliveries(db: DatabaseSync, now: number): Delivery[] {
  initDeliveryStore(db);
  db.prepare('DELETE FROM deliveries WHERE status_at < ?').run(now - STALE_MS);
  return (
    db.prepare('SELECT * FROM deliveries ORDER BY status_at DESC').all() as Record<
      string,
      unknown
    >[]
  )
    .map(rowToDelivery)
    .filter((d) => d.status !== 'entregado' || now - d.statusAt <= DELIVERED_KEEP_MS);
}

/** Cambios que merecen aviso y aún no se avisaron (uno por envío y estado). */
export function pendingDeliveryAlerts(db: DatabaseSync, now: number): Delivery[] {
  return activeDeliveries(db, now).filter(
    (d) =>
      ALERT_STATUSES.includes(d.status) &&
      d.notified !== d.status &&
      now - d.statusAt <= DELIVERY_ALERT_MAX_AGE_MS,
  );
}

export function markDeliveriesNotified(db: DatabaseSync, alerts: readonly Delivery[]): void {
  initDeliveryStore(db);
  const upd = db.prepare('UPDATE deliveries SET notified = ? WHERE key = ? AND status = ?');
  for (const a of alerts) upd.run(a.status, a.key, a.status);
}

/**
 * «Ya lo he recogido»: marca como entregado el envío que nombra el dueño (número,
 * transportista o palabras del asunto), para que deje de salir en el panel y el resumen.
 * Devuelve el envío marcado, los candidatos si hay varios, o [] si no hay ninguno.
 */
export function markDeliveryCollected(
  db: DatabaseSync,
  ref: string,
  now: number,
  /** Only this one (an answer like «el segundo» to a «¿Cuál?» list). */
  onlyKey?: string,
): { done: Delivery } | { matches: Delivery[] } {
  const q = foldRef(ref);
  const open = activeDeliveries(db, now).filter(
    (d) => d.status !== 'entregado' && (onlyKey === undefined || d.key === onlyKey),
  );
  if (onlyKey !== undefined) return markOne(db, open[0], now) ?? { matches: [] };
  const exact = open.filter((d) => [d.tracking, d.orderRef].some((r) => r && foldRef(r) === q));
  const words = q.split(' ').filter((w) => w.length > 2 && !REF_STOP.has(w));
  const loose = open.filter((d) => {
    const hay = foldRef(`${d.carrier} ${d.title} ${d.tracking ?? ''} ${d.orderRef ?? ''}`);
    return words.length > 0 && words.some((w) => hay.includes(w));
  });
  const matches = exact.length > 0 ? exact : loose;
  const one = matches.length === 1 ? matches[0] : open.length === 1 && !q ? open[0] : undefined;
  return markOne(db, one, now) ?? { matches };
}

function markOne(
  db: DatabaseSync,
  one: Delivery | undefined,
  now: number,
): { done: Delivery } | null {
  if (!one) return null;
  db.prepare(
    "UPDATE deliveries SET status = 'entregado', status_at = ?, notified = 'entregado', updated_at = ? WHERE key = ?",
  ).run(now, now, one.key);
  return { done: { ...one, status: 'entregado', statusAt: now, notified: 'entregado' } };
}

const REF_STOP = new Set([
  'paquete',
  'pedido',
  'envio',
  'del',
  'las',
  'los',
  'que',
  'ese',
  'este',
  'ya',
]);

function foldRef(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

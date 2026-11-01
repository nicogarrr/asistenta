/**
 * Clasificar un correo: importante / personal / notificación / publicidad / spam.
 *
 * Primero las cabeceras (List-Unsubscribe, List-Id, Precedence, Auto-Submitted,
 * remitentes «no-reply», Authentication-Results) y el historial del propio buzón
 * (gente a la que el dueño ha escrito). Solo si nada de eso decide se pregunta al
 * modelo, y si tampoco hay modelo queda como «importante»: lo dudoso nunca entra
 * en una limpieza. Todo es lectura: aquí no se mueve ni se borra nada.
 */

export type MailCategory = 'importante' | 'personal' | 'notificacion' | 'publicidad' | 'spam';

export const CATEGORY_LABEL: Record<MailCategory, string> = {
  importante: 'importante',
  personal: 'personal',
  notificacion: 'notificación',
  publicidad: 'publicidad/newsletter',
  spam: 'spam sospechoso',
};

export interface TriageInput {
  /** Dirección del remitente (puede venir como «Nombre <a@b.c>»). */
  from: string;
  /** Nombre visible del remitente, si se sabe aparte. */
  fromName?: string;
  replyTo?: string[];
  subject: string;
  text?: string;
  /** Cabeceras en minúsculas: list-unsubscribe, list-id, precedence, auto-submitted, authentication-results… */
  headers?: Record<string, string | undefined>;
}

export interface TriageHistory {
  /** Direcciones a las que el dueño ha escrito o contestado alguna vez. */
  contacts?: Iterable<string>;
}

export interface TriageResult {
  category: MailCategory;
  /** De dónde sale la decisión. */
  source: 'cabeceras' | 'historial' | 'modelo' | 'por defecto';
  reasons: string[];
}

/** Pregunta opcional al modelo para lo que las cabeceras no deciden. */
export type TriageModel = (input: {
  from: string;
  subject: string;
  snippet: string;
}) => Promise<MailCategory | null>;

export function addressOf(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

export function domainOf(address: string): string {
  const at = addressOf(address).lastIndexOf('@');
  return at < 0
    ? ''
    : addressOf(address)
        .slice(at + 1)
        .replace(/\.$/, '');
}

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gob', 'gov', 'ac', 'edu']);

/** «mail.news.amazon.co.uk» → «amazon.co.uk». Aproximado, sin lista pública de sufijos. */
export function baseDomain(domain: string): string {
  const parts = domain.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const tld = parts[parts.length - 1] ?? '';
  const sld = parts[parts.length - 2] ?? '';
  const take = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return parts.slice(-take).join('.');
}

/** Marcas que suelen suplantar, con sus dominios de verdad. */
const BRANDS: Record<string, string[]> = {
  paypal: ['paypal.com', 'paypal.es'],
  amazon: ['amazon.com', 'amazon.es', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it'],
  apple: ['apple.com', 'icloud.com'],
  google: ['google.com', 'google.es', 'gmail.com', 'youtube.com'],
  microsoft: ['microsoft.com', 'outlook.com', 'live.com', 'hotmail.com', 'office.com'],
  netflix: ['netflix.com'],
  bbva: ['bbva.es', 'bbva.com'],
  santander: ['bancosantander.es', 'santander.com', 'santander.es'],
  caixabank: ['caixabank.es', 'caixabank.com'],
  correos: ['correos.es', 'correos.com'],
  dhl: ['dhl.com', 'dhl.es'],
  seur: ['seur.com', 'seur.es'],
  revolut: ['revolut.com'],
  facebook: ['facebook.com', 'facebookmail.com', 'meta.com'],
  instagram: ['instagram.com', 'mail.instagram.com'],
  whatsapp: ['whatsapp.com'],
  agenciatributaria: ['agenciatributaria.es', 'agenciatributaria.gob.es'],
  sabadell: ['bancsabadell.com', 'sabadell.com'],
  openbank: ['openbank.es'],
};

function deLeet(label: string): string {
  return label
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/0/g, 'o')
    .replace(/[1l|]/g, 'l')
    .replace(/3/g, 'e')
    .replace(/5/g, 's')
    .replace(/[-_]/g, '');
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function isOfficial(brand: string, domain: string): boolean {
  const base = baseDomain(domain);
  return (BRANDS[brand] ?? []).some((d) => base === baseDomain(d) || domain === d);
}

/** La marca que este dominio imita sin serlo, o null. */
export function lookalikeBrand(domain: string): string | null {
  if (!domain) return null;
  const base = baseDomain(domain);
  const label = base.split('.')[0] ?? '';
  for (const brand of Object.keys(BRANDS)) {
    if (isOfficial(brand, domain)) return null;
  }
  for (const brand of Object.keys(BRANDS)) {
    const clean = deLeet(label);
    if (clean === brand && label !== brand) return brand;
    if (brand.length >= 5 && label !== brand && editDistanceAtMostOne(label, brand)) return brand;
    if (brand.length >= 5 && clean.includes(brand)) return brand;
    if (label === brand) return brand; // «paypal.xyz»: la marca con otro dominio
  }
  return null;
}

const URGENT =
  /\b(urgente|inmediat[oa]|24 ?horas|48 ?horas|suspendid[oa]|bloquead[oa]|caducad[oa]|último aviso|ultimo aviso|act[uú]a ya|immediately|suspended|locked|final notice)\b/i;
const MONEY_OR_LOGIN =
  /\b(pago|pagar|factura pendiente|deuda|multa|tarjeta|transferencia|bizum|reembolso|contraseña|verifica(r)? (tu|su) cuenta|confirma(r)? (tus|sus) datos|payment|verify your account|password|bank)\b/i;

/** Señales de suplantación/estafa. Vacío = nada raro. */
export function phishingSignals(input: TriageInput): string[] {
  const signals: string[] = [];
  const fromDomain = domainOf(input.from);
  const brand = lookalikeBrand(fromDomain);
  if (brand) signals.push(`el dominio ${fromDomain} imita a ${brand}`);
  const name = (input.fromName ?? input.from.replace(/<[^>]*>/, '')).toLowerCase();
  if (!brand) {
    for (const b of Object.keys(BRANDS)) {
      if (b.length >= 4 && name.includes(b) && fromDomain && !isOfficial(b, fromDomain)) {
        signals.push(`dice ser ${b} pero escribe desde ${fromDomain}`);
        break;
      }
    }
  }
  const replyDomains = (input.replyTo ?? []).map(domainOf).filter(Boolean);
  const foreign = replyDomains.find((d) => baseDomain(d) !== baseDomain(fromDomain));
  if (foreign && fromDomain) signals.push(`responder va a ${foreign}, no a ${fromDomain}`);
  const auth = (input.headers?.['authentication-results'] ?? '').toLowerCase();
  if (/\b(spf|dkim|dmarc)=fail\b/.test(auth)) signals.push('no pasa la verificación del remitente');
  const body = `${input.subject}\n${(input.text ?? '').slice(0, 2000)}`;
  if (URGENT.test(body) && MONEY_OR_LOGIN.test(body))
    signals.push('pide pago o datos con urgencia');
  return signals;
}

/** Sospechoso si imita una marca o junta dos señales. */
export function looksLikePhishing(signals: string[]): boolean {
  return signals.some((s) => s.includes(' imita a ')) || signals.length >= 2;
}

/**
 * Aviso en una línea para un correo que huele a estafa, o '' si no. Solo avisa: no mueve,
 * no borra, no contesta. Se usa al llegar el correo (atención) y al leerlo en el chat.
 */
export function scamWarning(m: TriageInput): string {
  const signals = phishingSignals(m);
  if (!looksLikePhishing(signals)) return '';
  return `⚠️ Posible estafa: ${signals.slice(0, 2).join('; ')}. No pagues ni des datos sin comprobarlo por otro lado.`;
}

/** El texto de un correo nuevo para la cola de atención, con el aviso de estafa delante. */
export function mailAttentionText(m: { from: string; subject: string; text: string }): string {
  const warn = scamWarning(m);
  return `${warn ? `${warn}\n` : ''}${m.subject}\n${m.text}`;
}

const NO_REPLY =
  /^(no-?reply|do-?not-?reply|noreply|notifica(tions|ciones)|notify|alerts?|avisos?|mailer-daemon|postmaster|info|news|newsletter|boletin|marketing|promo(ciones)?)([+.-].*)?@/i;
const TRANSACTIONAL =
  /\b(pedido|order|env[ií]o|enviado|entrega|factura|recibo|ticket|reserva|cita|c[oó]digo|contraseña|password|verificaci[oó]n|confirmaci[oó]n|tu cuenta|pago recibido|cargo|shipped|delivered|invoice|receipt)\b/i;

/** Clasifica por cabeceras e historial; null si no hay nada claro. */
export function classifyByHeaders(
  input: TriageInput,
  history: TriageHistory = {},
): TriageResult | null {
  const h = input.headers ?? {};
  const signals = phishingSignals(input);
  if (looksLikePhishing(signals))
    return { category: 'spam', source: 'cabeceras', reasons: signals };
  const from = addressOf(input.from);
  const contacts = new Set([...(history.contacts ?? [])].map(addressOf));
  const bulk: string[] = [];
  if (h['list-unsubscribe']) bulk.push('trae enlace de baja');
  if (h['list-id']) bulk.push('es de una lista');
  if (/\b(bulk|list|junk)\b/i.test(h.precedence ?? '')) bulk.push(`Precedence: ${h.precedence}`);
  if (contacts.has(from) && bulk.length === 0)
    return { category: 'personal', source: 'historial', reasons: ['le has escrito antes'] };
  const transactional = TRANSACTIONAL.test(input.subject);
  if (bulk.length > 0)
    return transactional
      ? {
          category: 'notificacion',
          source: 'cabeceras',
          reasons: [...bulk, 'parece un aviso de servicio'],
        }
      : { category: 'publicidad', source: 'cabeceras', reasons: bulk };
  const auto = /^auto-/i.test(h['auto-submitted'] ?? '');
  if (NO_REPLY.test(from) || auto)
    return {
      category: 'notificacion',
      source: 'cabeceras',
      reasons: [auto ? 'enviado automáticamente' : 'remitente automático'],
    };
  return null;
}

export async function classifyMail(
  input: TriageInput,
  history: TriageHistory = {},
  model?: TriageModel,
): Promise<TriageResult> {
  const byHeaders = classifyByHeaders(input, history);
  if (byHeaders) return byHeaders;
  if (model) {
    try {
      const category = await model({
        from: addressOf(input.from),
        subject: input.subject.slice(0, 200),
        snippet: (input.text ?? '').replace(/\s+/g, ' ').slice(0, 300),
      });
      if (category && category in CATEGORY_LABEL)
        return { category, source: 'modelo', reasons: ['lo decidió el modelo'] };
    } catch {
      // Sin modelo no se adivina: queda como importante.
    }
  }
  return {
    category: 'importante',
    source: 'por defecto',
    reasons: ['sin señales de envío masivo'],
  };
}

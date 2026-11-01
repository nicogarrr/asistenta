/**
 * Bajas de listas de correo, solo de los remitentes del lote que Nico aprobó: POST de un clic
 * (RFC 8058) sin redirecciones; mailto va como correo nuevo con su aprobación; un enlace normal
 * se le pasa a Nico, nunca se visita. Cada baja queda apuntada («¿de qué me he dado de baja?»).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileReplacing } from '../fs-tmp.js';
import { STATE_DIR } from '../paths.js';
import type { ScannedMail } from './scan.js';

export type UnsubMethod = 'un-clic' | 'correo' | 'enlace';

export interface UnsubTarget {
  remitente: string;
  correos: number;
  metodo: UnsubMethod;
  destino: string;
}

export interface UnsubBatch {
  id: string;
  creado: number;
  objetivos: UnsubTarget[];
}

export interface UnsubRecord {
  remitente: string;
  metodo: UnsubMethod;
  hora: string;
  resultado: string;
}

const TTL_MS = 60 * 60_000;
const file = (name: string) => join(STATE_DIR, name);

function readJson<T>(path: string): T[] {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(data) ? (data as T[]) : [];
  } catch {
    return [];
  }
}

/** Las direcciones de List-Unsubscribe y si el remitente ofrece el un clic de RFC 8058. */
export function parseUnsubscribe(
  headers: Record<string, string>,
): Omit<UnsubTarget, 'remitente' | 'correos'> | null {
  const links = [...(headers['list-unsubscribe'] ?? '').matchAll(/<([^>]+)>/g)].map(
    (m) => m[1]?.trim() ?? '',
  );
  const https = links.find((l) => /^https:\/\//i.test(l));
  const mailto = links.find((l) => /^mailto:/i.test(l));
  const oneClick = /List-Unsubscribe=One-Click/i.test(headers['list-unsubscribe-post'] ?? '');
  if (https && oneClick) return { metodo: 'un-clic', destino: https };
  if (mailto) return { metodo: 'correo', destino: mailto.slice(7) };
  if (https) return { metodo: 'enlace', destino: https };
  return null;
}

/** Remitentes con baja posible, con cuántos correos mandaron (el más reciente manda). */
export function unsubscribeTargets(mails: readonly ScannedMail[]): UnsubTarget[] {
  const by = new Map<string, UnsubTarget>();
  for (const m of [...mails].sort((a, b) => b.at - a.at)) {
    const parsed = parseUnsubscribe(m.headers);
    if (!parsed || !m.from) continue;
    const seen = by.get(m.from);
    if (seen) seen.correos += 1;
    else by.set(m.from, { remitente: m.from, correos: 1, ...parsed });
  }
  return [...by.values()].sort(
    (a, b) => b.correos - a.correos || a.remitente.localeCompare(b.remitente),
  );
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
};

export function describeTarget(t: UnsubTarget, n: number): string {
  const how =
    t.metodo === 'un-clic'
      ? `baja de un clic en ${host(t.destino)}`
      : t.metodo === 'correo'
        ? `baja por correo a ${t.destino.split('?')[0]} (te enseñaré el borrador)`
        : 'solo enlace: te lo paso para que lo abras tú';
  return `${n}. ${t.remitente} (${t.correos} ${t.correos === 1 ? 'correo' : 'correos'}): ${how}`;
}

export function saveUnsubBatch(objetivos: UnsubTarget[], now: number): UnsubBatch {
  const live = readJson<UnsubBatch>(file('mail-unsub-batches.json')).filter(
    (b) => now - b.creado < TTL_MS,
  );
  const batch = { id: randomBytes(4).toString('hex'), creado: now, objetivos };
  writeFileReplacing(file('mail-unsub-batches.json'), JSON.stringify([...live.slice(-9), batch]));
  return batch;
}

export function findUnsubBatch(id: string, now: number): UnsubBatch | null {
  const b = readJson<UnsubBatch>(file('mail-unsub-batches.json')).find((x) => x.id === id);
  return b && now - b.creado < TTL_MS ? b : null;
}

function dropUnsubBatch(id: string): void {
  const all = readJson<UnsubBatch>(file('mail-unsub-batches.json'));
  writeFileReplacing(
    file('mail-unsub-batches.json'),
    JSON.stringify(all.filter((b) => b.id !== id)),
  );
}

/** La pregunta de aprobación de `baja`: la lista exacta del lote. */
export function unsubQuestion(id: string, now: number): string | null {
  const b = findUnsubBatch(id, now);
  return b
    ? `¿Te doy de baja de estos (lote ${b.id})?\n${b.objetivos.map((t, i) => describeTarget(t, i + 1)).join('\n')}`
    : null;
}

export function unsubLog(): UnsubRecord[] {
  return readJson<UnsubRecord>(file('mail-unsubscribed.json'));
}

/** Hace las bajas del lote (se gasta al usarlo) y apunta cada una. */
export async function runUnsubBatch(
  id: string,
  now: number,
  post: (url: string) => Promise<number>,
): Promise<UnsubRecord[] | null> {
  const batch = findUnsubBatch(id, now);
  if (!batch) return null;
  dropUnsubBatch(id);
  const hora = new Date(now).toISOString();
  const done: UnsubRecord[] = [];
  for (const t of batch.objetivos) {
    let resultado = 'te paso el enlace para que lo abras tú';
    if (t.metodo === 'correo') resultado = `pendiente: correo de baja a ${t.destino.split('?')[0]}`;
    if (t.metodo === 'un-clic') {
      const status = await post(t.destino).catch(() => 0);
      resultado =
        status >= 200 && status < 300
          ? 'hecho'
          : `no confirmado (respuesta ${status || 'ninguna'})`;
    }
    done.push({ remitente: t.remitente, metodo: t.metodo, hora, resultado });
  }
  writeFileReplacing(
    file('mail-unsubscribed.json'),
    JSON.stringify([...unsubLog(), ...done].slice(-500)),
  );
  return done;
}

/** El POST de RFC 8058: sin cookies, sin seguir redirecciones, con tiempo límite. */
export async function oneClickPost(url: string): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

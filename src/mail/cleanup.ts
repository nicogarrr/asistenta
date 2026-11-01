/**
 * «Limpia lo no importante»: primero una vista previa (cuántos correos, de quién, ejemplos)
 * que se guarda como un lote con la lista exacta de UIDs; luego, solo si Nico aprueba ESE
 * lote (la Gate pregunta cada vez, approval-text enseña este resumen), se mueven esos y
 * ningún otro. Un lote caduca en una hora y se gasta al usarlo.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileReplacing } from '../fs-tmp.js';
import { STATE_DIR } from '../paths.js';
import { sliceSafe } from '../text.js';
import { MOVE_TARGET_LABEL, type MoveTarget } from './move.js';
import { type MailRule, matchRule } from './rules.js';
import type { ScannedMail } from './scan.js';
import { CATEGORY_LABEL, classifyByHeaders, domainOf, type MailCategory } from './triage.js';

export const BATCH_TTL_MS = 60 * 60_000;
const MAX_BATCHES = 10;
const MAX_SUMMARY = 1500;

export interface CleanupBatch {
  id: string;
  account: string;
  uidValidity: string;
  uids: number[];
  accion: MoveTarget;
  creado: number;
  resumen: string;
}

export interface CleanupFilter {
  categoria?: MailCategory;
  remitente?: string;
  regla?: MailRule;
  accion?: MoveTarget;
}

export function defaultBatchFile(): string {
  return join(STATE_DIR, 'mail-cleanup.json');
}

export function loadBatches(file = defaultBatchFile()): CleanupBatch[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(data) ? (data as CleanupBatch[]).filter((b) => b?.id) : [];
  } catch {
    return [];
  }
}

const DEFAULT_CATEGORIES: MailCategory[] = ['publicidad', 'notificacion'];

function categoryOf(m: ScannedMail): MailCategory {
  return classifyByHeaders(m)?.category ?? 'importante';
}

/** Qué correos entrarían en la limpieza y con qué acción. No toca nada. */
export function selectForCleanup(
  mails: readonly ScannedMail[],
  filter: CleanupFilter,
): { picked: Array<ScannedMail & { category: MailCategory }>; accion: MoveTarget } {
  const want = filter.remitente?.trim().toLowerCase();
  const accion: MoveTarget =
    filter.accion ??
    (filter.regla && filter.regla.accion !== 'leido' ? filter.regla.accion : 'limpieza');
  const picked: Array<ScannedMail & { category: MailCategory }> = [];
  for (const m of mails) {
    const category = categoryOf(m);
    if (filter.regla) {
      if (!matchRule([filter.regla], { from: m.from, subject: m.subject, category })) continue;
    } else if (filter.categoria) {
      if (category !== filter.categoria) continue;
    } else if (!want && !DEFAULT_CATEGORIES.includes(category)) continue;
    if (want && !m.from.includes(want)) continue;
    picked.push({ ...m, category });
  }
  return { picked, accion };
}

/** El texto de la vista previa: total, remitentes con cuántos y ejemplos de asunto. */
export function describeSelection(
  picked: ReadonlyArray<ScannedMail & { category: MailCategory }>,
  accion: MoveTarget,
): string {
  const bySender = new Map<string, ScannedMail[]>();
  for (const m of picked) {
    const key = domainOf(m.from) || m.from;
    bySender.set(key, [...(bySender.get(key) ?? []), m]);
  }
  const byCat = new Map<MailCategory, number>();
  for (const m of picked) byCat.set(m.category, (byCat.get(m.category) ?? 0) + 1);
  const senders = [...bySender.entries()].sort((a, b) => b[1].length - a[1].length);
  const lines = [
    `${MOVE_TARGET_LABEL[accion]}: ${picked.length} ${picked.length === 1 ? 'correo' : 'correos'}.`,
  ];
  for (const [sender, list] of senders.slice(0, 8)) {
    const examples = list
      .slice(0, 2)
      .map((m) => `«${m.subject.replace(/\s+/g, ' ').slice(0, 50)}»`)
      .join(', ');
    lines.push(`• ${sender}: ${list.length} (p. ej. ${examples})`);
  }
  if (senders.length > 8)
    lines.push(
      `• y ${senders.length - 8} remitentes más (${senders
        .slice(8)
        .reduce((n, [, l]) => n + l.length, 0)} correos)`,
    );
  lines.push(
    [...byCat.entries()].map(([c, n]) => `${CATEGORY_LABEL[c]} ${n}`).join(', ') || 'Nada.',
  );
  const text = lines.join('\n');
  return text.length > MAX_SUMMARY ? `${sliceSafe(text, MAX_SUMMARY - 1)}…` : text;
}

/** Guarda el lote para que «sí» actúe sobre esta lista exacta. Devuelve su id. */
export function saveBatch(
  batch: Omit<CleanupBatch, 'id' | 'creado'>,
  now: number,
  file = defaultBatchFile(),
): CleanupBatch {
  const live = loadBatches(file).filter((b) => now - b.creado < BATCH_TTL_MS);
  let id = randomBytes(4).toString('hex');
  while (live.some((b) => b.id === id)) id = randomBytes(4).toString('hex');
  const saved: CleanupBatch = { ...batch, id, creado: now };
  writeFileReplacing(file, JSON.stringify([...live.slice(-(MAX_BATCHES - 1)), saved], null, 2));
  return saved;
}

/** Un lote vivo por id (sin gastarlo). */
export function findBatch(id: string, now: number, file = defaultBatchFile()): CleanupBatch | null {
  const found = loadBatches(file).find((b) => b.id === id);
  return found && now - found.creado < BATCH_TTL_MS ? found : null;
}

/** Gasta el lote: después de esto el mismo id ya no actúa. */
export function takeBatch(id: string, now: number, file = defaultBatchFile()): CleanupBatch | null {
  const all = loadBatches(file);
  const found = findBatch(id, now, file);
  writeFileReplacing(
    file,
    JSON.stringify(
      all.filter((b) => b.id !== id && now - b.creado < BATCH_TTL_MS),
      null,
      2,
    ),
  );
  return found;
}

/** La pregunta de aprobación para un lote: la lista exacta que se va a mover. */
export function batchQuestion(id: string, now: number, file = defaultBatchFile()): string | null {
  const b = findBatch(id, now, file);
  return b ? `¿Hago esto con tu correo (lote ${b.id})?\n${b.resumen}` : null;
}

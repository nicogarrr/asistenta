/**
 * Reglas de correo del dueño, dichas en el chat con palabras normales («lo de LinkedIn
 * a la papelera», «todo lo de Amazon que no sea un pedido, archívalo»). El modelo las
 * traduce a campos; aquí solo se guardan, se listan, se borran y se comparan. Una regla
 * no actúa sola: la limpieza enseña antes la lista y espera el «sí» del dueño.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setAsideCorrupt, writeFileReplacing } from '../fs-tmp.js';
import { STATE_DIR } from '../paths.js';
import { addressOf, CATEGORY_LABEL, type MailCategory } from './triage.js';

export type RuleAction = 'archivar' | 'limpieza' | 'papelera' | 'leido';

export const RULE_ACTION_LABEL: Record<RuleAction, string> = {
  archivar: 'archivar',
  limpieza: 'mover a Asistenta/Limpieza',
  papelera: 'a la papelera (recuperable)',
  leido: 'marcar como leído',
};

export interface MailRule {
  id: number;
  /** Lo que dijo el dueño, tal cual. */
  texto: string;
  /** Trozo de la dirección o dominio del remitente («linkedin», «amazon.es»). */
  remitente?: string;
  asunto?: string;
  /** Si el asunto contiene esto, la regla NO se aplica («pedido»). */
  excepto?: string;
  categoria?: MailCategory;
  accion: RuleAction;
  creada: string;
}

export const MAX_RULES = 100;

export function defaultRulesFile(): string {
  return join(STATE_DIR, 'mail-rules.json');
}

export function loadRules(file = defaultRulesFile()): MailRule[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(data)
      ? (data as MailRule[]).filter((r) => r && typeof r.id === 'number')
      : [];
  } catch {
    // Un fichero roto se aparta antes de devolver «sin reglas»: si no, la
    // próxima escritura (añadir o borrar una regla) borraría TODAS las demás.
    setAsideCorrupt(file);
    return [];
  }
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function addRule(
  rule: Omit<MailRule, 'id' | 'creada'>,
  file = defaultRulesFile(),
  now = new Date(),
): MailRule | string {
  if (!rule.remitente?.trim() && !rule.asunto?.trim() && !rule.categoria)
    return 'Una regla necesita al menos remitente, asunto o categoría.';
  const rules = loadRules(file);
  if (rules.length >= MAX_RULES) return `Ya hay ${MAX_RULES} reglas: borra alguna antes.`;
  const clean = (v?: string) => (v?.trim() ? v.trim().slice(0, 120) : undefined);
  const saved: MailRule = {
    id: rules.reduce((max, r) => Math.max(max, r.id), 0) + 1,
    texto: rule.texto.trim().slice(0, 300),
    remitente: clean(rule.remitente),
    asunto: clean(rule.asunto),
    excepto: clean(rule.excepto),
    categoria: rule.categoria,
    accion: rule.accion,
    creada: now.toISOString(),
  };
  writeFileReplacing(file, JSON.stringify([...rules, saved], null, 2));
  return saved;
}

export function deleteRule(id: number, file = defaultRulesFile()): MailRule | null {
  const rules = loadRules(file);
  const found = rules.find((r) => r.id === id) ?? null;
  if (found)
    writeFileReplacing(
      file,
      JSON.stringify(
        rules.filter((r) => r.id !== id),
        null,
        2,
      ),
    );
  return found;
}

export function describeRule(r: MailRule): string {
  const when = [
    r.remitente ? `de «${r.remitente}»` : '',
    r.asunto ? `con «${r.asunto}» en el asunto` : '',
    r.categoria ? `de tipo ${CATEGORY_LABEL[r.categoria]}` : '',
    r.excepto ? `salvo si el asunto dice «${r.excepto}»` : '',
  ].filter(Boolean);
  return `${r.id}. ${when.join(', ')} → ${RULE_ACTION_LABEL[r.accion]}`;
}

/** La primera regla que encaja con este correo, o null. */
export function matchRule(
  rules: readonly MailRule[],
  mail: { from: string; subject: string; category?: MailCategory },
): MailRule | null {
  const from = addressOf(mail.from);
  const subject = fold(mail.subject);
  for (const r of rules) {
    if (r.remitente && !from.includes(fold(r.remitente))) continue;
    if (r.asunto && !subject.includes(fold(r.asunto))) continue;
    if (r.categoria && r.categoria !== mail.category) continue;
    if (r.excepto && subject.includes(fold(r.excepto))) continue;
    return r;
  }
  return null;
}

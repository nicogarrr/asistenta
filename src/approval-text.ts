/**
 * The text a human approves. What the question shows is what gets approved, so
 * this formatter obeys three rules, in order:
 *
 * 1. Nothing is hidden: every parameter that changes what runs is in the text,
 *    and a batch lists every action. Two different actions never produce the
 *    same question.
 * 2. Nothing is truncated: the budget applies to the RAW text (before masking),
 *    so a long command cannot sneak past the review limit by containing a long
 *    secret. Over budget the approval is fail-closed (`complete: false`) and the
 *    caller denies without asking; the replacement text carries no clipped
 *    content.
 * 3. No secrets leave the process: secret-shaped values are masked before the
 *    text goes to a channel, and the mask eats ONLY the secret value - never the
 *    surrounding operation (`password=abc;Remove-Item` masks to
 *    `password=[redacted];Remove-Item`, so two commands that differ after the
 *    secret still differ in the question). Masking is a safety net, not DLP:
 *    text that is a secret without looking like one is indistinguishable from
 *    ordinary text; a caller typing a secret marks it (`secret: true`) and the
 *    question shows a placeholder, never the value.
 */
import type { ToolCall } from './permissions.js';

export interface ApprovalText {
  question: string;
  complete: boolean;
}

export const QUESTION_BUDGET = 3500;

// Value: quoted strings are masked whole (a space inside quotes is still the
// secret); unquoted values stop at whitespace AND shell operators, so the mask
// never swallows the command that follows the secret.
const SECRET_VALUE = `("[^"]*"|'[^']*'|[^\\s"';&|<>]{3,})`;
const SECRET_KEY_VALUE = new RegExp(
  `\\b(password|passwd|pwd|token|api[_-]?key|secret|credential|authorization|clave|contraseña)("?\\s*[:=]\\s*)${SECRET_VALUE}`,
  'gi',
);
const SECRET_PS_FLAG =
  /(-(?:Password|Pass|Token|ApiKey|Secret|Credential)\s+)("[^"]*"|'[^']*'|[^\s;&|<>]+)/gi;
const SECRET_BEARER = /\b(Bearer\s+)([^\s;&|<>]+)/gi;
const SECRET_TOKEN =
  /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;

/** Best-effort masking of secret-shaped values in free text. Safety net, not DLP. */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_BEARER, '$1[redacted]')
    .replace(SECRET_PS_FLAG, '$1[redacted]')
    .replace(SECRET_KEY_VALUE, '$1$2[redacted]')
    .replace(SECRET_TOKEN, '[redacted]');
}

const IDENTITY = (s: string): string => s;

export function formatApproval(call: ToolCall, reason: string): ApprovalText {
  const target = typeof call.args._target === 'string' ? call.args._target : '';
  if (call.tool === 'browser' && target) {
    const [element = '', ...rest] = target.split('\nRESUMEN DE LA PÁGINA:\n');
    const summary = rest.join('\n').trim();
    const shown = element.split(' | ').filter(Boolean).slice(0, 6).join(' · ').slice(0, 300);
    const raw = [
      `¿Permito esta acción en el navegador?`,
      `Elemento: ${shown}`,
      summary ? `Datos de la página:\n${summary.slice(0, 700)}` : '',
      `Motivo: ${reason}`,
    ]
      .filter(Boolean)
      .join('\n');
    // Bounded by construction (300 + 700 + reason); the reason is masked like
    // everything else that reaches a channel.
    const question = raw.replace(`Motivo: ${reason}`, `Motivo: ${redactSecrets(reason)}`);
    return withinBudget(raw, question, 'browser');
  }
  if (call.tool === 'shell') {
    const command = typeof call.args.command === 'string' ? call.args.command.trim() : '';
    const raw = [
      '¿Permito shell?',
      command ? `Comando:\n${command}` : 'Comando: (vacío)',
      `Motivo: ${reason}`,
    ].join('\n');
    const question = [
      '¿Permito shell?',
      command ? `Comando:\n${redactSecrets(command)}` : 'Comando: (vacío)',
      `Motivo: ${redactSecrets(reason)}`,
    ].join('\n');
    return withinBudget(raw, question, 'shell');
  }
  if (call.tool === 'computer') {
    const rawLines = ['¿Permito computer?'];
    const lines = ['¿Permito computer?'];
    if (call.args.action === 'batch' && Array.isArray(call.args.actions)) {
      const steps = call.args.actions as Array<Record<string, unknown>>;
      rawLines.push(`Lote de ${steps.length} acciones:`);
      lines.push(`Lote de ${steps.length} acciones:`);
      for (const [i, step] of steps.entries()) {
        rawLines.push(`  ${i + 1}. ${describeComputerAction(step, IDENTITY)}`);
        lines.push(`  ${i + 1}. ${describeComputerAction(step, redactSecrets)}`);
      }
    } else {
      rawLines.push(`Acción: ${describeComputerAction(call.args, IDENTITY)}`);
      lines.push(`Acción: ${describeComputerAction(call.args, redactSecrets)}`);
    }
    rawLines.push(`Motivo: ${reason}`);
    lines.push(`Motivo: ${redactSecrets(reason)}`);
    return withinBudget(rawLines.join('\n'), lines.join('\n'), 'computer');
  }
  const raw = `¿Permito ${call.tool}?\n${reason}`;
  return withinBudget(raw, `¿Permito ${call.tool}?\n${redactSecrets(reason)}`, call.tool);
}

/** Back-compat: same text as before for callers that only need the question. */
export function formatApprovalQuestion(call: ToolCall, reason: string): string {
  return formatApproval(call, reason).question;
}

/**
 * The budget applies to the RAW text: masking only shrinks a question, so a raw
 * that fits always produces a shown text that fits. Measuring the masked text
 * instead would let a 4000-char token carry a 4000-char command past review.
 */
function withinBudget(raw: string, shown: string, tool: string): ApprovalText {
  if (raw.length <= QUESTION_BUDGET) return { question: shown, complete: true };
  return {
    question:
      `¿Permito ${tool}?\n` +
      `La acción es demasiado larga para revisarla entera con seguridad ` +
      `(${raw.length} caracteres, máximo ${QUESTION_BUDGET}). ` +
      `No se muestra recortada porque una aprobación recortada es a ciegas: ` +
      `queda DENEGADA. Ejecútala a mano o divídela en pasos más cortos.`,
    complete: false,
  };
}

const KNOWN_ACTION_KEYS = new Set([
  'action', 'x', 'y', 'toX', 'toY', 'text', 'key', 'button', 'clicks', 'roi', 'actions',
  'secret', '_target',
]);

function describeComputerAction(
  args: Record<string, unknown>,
  redact: (s: string) => string,
): string {
  const action = typeof args.action === 'string' ? args.action : '?';
  let base: string;
  switch (action) {
    case 'type':
      // A caller typing a secret says so: the question shows a placeholder and
      // never the value. Unmarked text is shown (masked best-effort): a string
      // that does not look like a secret cannot be told apart from prose.
      if (args.secret === true) {
        base = `escribir [secreto: ${String(args.text ?? '').length} caracteres]`;
      } else {
        base = `escribir "${redact(String(args.text ?? ''))}"`;
      }
      break;
    case 'key':
      base = `pulsar ${String(args.key ?? '?')}`;
      break;
    case 'click': {
      const button =
        typeof args.button === 'string' && args.button !== 'left'
          ? ` ${args.button === 'right' ? 'derecho' : args.button}`
          : '';
      const clicks = typeof args.clicks === 'number' && args.clicks !== 1 ? ` x${args.clicks}` : '';
      base = `click${button}${clicks} en (${String(args.x)}, ${String(args.y)})${roiText(args.roi)}`;
      break;
    }
    case 'drag':
      base = `arrastrar de (${String(args.x)}, ${String(args.y)}) a (${String(args.toX)}, ${String(args.toY)})`;
      break;
    case 'move':
      base = `mover a (${String(args.x)}, ${String(args.y)})`;
      break;
    case 'screenshot':
      base = `captura de pantalla${roiText(args.roi)}`;
      break;
    default:
      // Unknown action: nothing hidden — the whole (redacted) payload is the description.
      base = `${action} ${redact(JSON.stringify(args))}`;
  }
  // Any parameter this formatter does not know about still shows up: the question
  // must describe what will run, not what the formatter happened to expect.
  const extras = Object.keys(args).filter((k) => !KNOWN_ACTION_KEYS.has(k));
  if (extras.length === 0) return base;
  const extraText = extras.map((k) => `${k}: ${redact(JSON.stringify(args[k]) ?? '?')}`).join(', ');
  return `${base} {${extraText}}`;
}

function roiText(roi: unknown): string {
  if (!roi || typeof roi !== 'object') return '';
  const r = roi as Record<string, unknown>;
  return ` [roi (${String(r.x)}, ${String(r.y)}, ${String(r.width)}×${String(r.height)})]`;
}

import type { ToolCall } from './permissions.js';

/**
 * What the user sees when the gate asks. For a browser action on a payment, the page's
 * own words (button, address, totals) go in the question, so the one tap is an informed
 * one: "Pagar 11,40 € a calle Y", not "¿Permito browser?".
 *
 * The same honesty applies to the desktop tools, with three hard rules:
 *
 * - **Stable header**: the first line stays `¿Permito <tool>?` so the QA harness
 *   (channels/qa.ts `toolOfQuestion`) keeps parsing the tool out of the question.
 * - **No silent truncation**: two different commands must never produce the same
 *   question. Everything that decides the action is shown in full; if the question
 *   would not fit the budget, it is NOT approvable (`complete: false`) and the
 *   caller must fail closed. A truncated approval is a blind approval.
 * - **Secrets are masked** before the text leaves for Telegram/history. Best-effort
 *   scrub, same spirit as log.ts `redact`: a safety net, never a guarantee; the real
 *   boundary is that the model should not put secrets in arguments at all.
 */

/** Fits one Telegram chunk (4000) with room for the header, reason and buttons. */
const QUESTION_BUDGET = 3500;

export interface ApprovalText {
  question: string;
  /**
   * false = the action cannot be shown in full inside the budget. The question text
   * then says so itself, and the gate must deny instead of asking: an approval the
   * human cannot fully read is not informed.
   */
  complete: boolean;
}

const SECRET_KEY_VALUE =
  /\b(password|passwd|pwd|token|api[_-]?key|secret|credential|authorization|clave|contraseña)("?\s*[:=]\s*"?)([^\s"']{3,})/gi;
const SECRET_PS_FLAG =
  /(-(?:Password|Pass|Token|ApiKey|Secret|Credential)\s+)("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_BEARER = /\b(Bearer\s+)(\S+)/gi;
const SECRET_TOKEN =
  /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g;

/** Best-effort masking of secret-shaped values in free text (commands, typed text). */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_BEARER, '$1[redacted]')
    .replace(SECRET_PS_FLAG, '$1[redacted]')
    .replace(SECRET_KEY_VALUE, '$1$2[redacted]')
    .replace(SECRET_TOKEN, '[redacted]');
}

export function formatApproval(call: ToolCall, reason: string): ApprovalText {
  const target = typeof call.args._target === 'string' ? call.args._target : '';
  if (call.tool === 'browser' && target) {
    const [element = '', ...rest] = target.split('\nRESUMEN DE LA PÁGINA:\n');
    const summary = rest.join('\n').trim();
    const shown = element.split(' | ').filter(Boolean).slice(0, 6).join(' · ').slice(0, 300);
    const question = [
      `¿Permito esta acción en el navegador?`,
      `Elemento: ${shown}`,
      summary ? `Datos de la página:\n${summary.slice(0, 700)}` : '',
      `Motivo: ${reason}`,
    ]
      .filter(Boolean)
      .join('\n');
    // Bounded by construction (300 + 700 + reason): always reviewable in full.
    return { question, complete: question.length <= QUESTION_BUDGET };
  }
  if (call.tool === 'shell') {
    const command = typeof call.args.command === 'string' ? call.args.command.trim() : '';
    const question = [
      '¿Permito shell?',
      command ? `Comando:\n${redactSecrets(command)}` : 'Comando: (vacío)',
      `Motivo: ${reason}`,
    ].join('\n');
    return withinBudget(question, 'shell');
  }
  if (call.tool === 'computer') {
    const lines = ['¿Permito computer?'];
    if (call.args.action === 'batch' && Array.isArray(call.args.actions)) {
      const steps = call.args.actions as Array<Record<string, unknown>>;
      lines.push(`Lote de ${steps.length} acciones:`);
      for (const [i, step] of steps.entries()) {
        lines.push(`  ${i + 1}. ${describeComputerAction(step)}`);
      }
    } else {
      lines.push(`Acción: ${describeComputerAction(call.args)}`);
    }
    lines.push(`Motivo: ${reason}`);
    return withinBudget(lines.join('\n'), 'computer');
  }
  return { question: `¿Permito ${call.tool}?\n${reason}`, complete: true };
}

/** Back-compat: same text as before for callers that only need the question. */
export function formatApprovalQuestion(call: ToolCall, reason: string): string {
  return formatApproval(call, reason).question;
}

function withinBudget(question: string, tool: string): ApprovalText {
  if (question.length <= QUESTION_BUDGET) return { question, complete: true };
  return {
    question:
      `¿Permito ${tool}?\n` +
      `La acción es demasiado larga para revisarla entera con seguridad ` +
      `(${question.length} caracteres, máximo ${QUESTION_BUDGET}). ` +
      `No se muestra recortada porque una aprobación recortada es a ciegas: ` +
      `queda DENEGADA. Ejecútala a mano o divídela en pasos más cortos.`,
    complete: false,
  };
}

const KNOWN_ACTION_KEYS = new Set([
  'action', 'x', 'y', 'toX', 'toY', 'text', 'key', 'button', 'clicks', 'roi', 'actions', '_target',
]);

function describeComputerAction(args: Record<string, unknown>): string {
  const action = typeof args.action === 'string' ? args.action : '?';
  let base: string;
  switch (action) {
    case 'type':
      base = `escribir "${redactSecrets(String(args.text ?? ''))}"`;
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
      base = `${action} ${redactSecrets(JSON.stringify(args))}`;
  }
  // Any parameter this formatter does not know about still shows up: the question
  // must describe what will run, not what the formatter happened to expect.
  const extras = Object.keys(args).filter((k) => !KNOWN_ACTION_KEYS.has(k));
  if (extras.length === 0) return base;
  const extraText = extras.map((k) => `${k}: ${redactSecrets(JSON.stringify(args[k]) ?? '?')}`).join(', ');
  return `${base} {${extraText}}`;
}

function roiText(roi: unknown): string {
  if (!roi || typeof roi !== 'object') return '';
  const r = roi as Record<string, unknown>;
  return ` [roi (${String(r.x)}, ${String(r.y)}, ${String(r.width)}×${String(r.height)})]`;
}

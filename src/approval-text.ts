/**
 * The text a human approves. What the question shows is what gets approved, so
 * this formatter obeys three rules, in order:
 *
 * 1. Nothing is hidden: every parameter that changes what runs is in the text,
 *    and a batch lists every action. Two different actions never produce the
 *    same question.
 * 2. Nothing is truncated: the budget applies to the RAW text, so a long
 *    command cannot sneak past the review limit. Over budget the approval is
 *    fail-closed (`complete: false`) and the caller denies without asking; the
 *    replacement text carries no clipped content.
 * 3. Nothing is masked in what runs: masking a shell command can hide part of
 *    the operation itself (PowerShell executes $() subexpressions inside double
 *    quotes; backticks and escapes are not parsed), so a command or typed text
 *    that the mask would ALTER is denied, not shown masked - approving an
 *    altered rendering is approving blind. Typing a secret (type with
 *    `secret: true`) is denied too, until a vault flow can reference the secret
 *    without showing it. redactSecrets survives only for prose that is not the
 *    operation (the reason) and as a best-effort safety net, NOT as DLP: text
 *    that is a secret without looking like one is indistinguishable from
 *    ordinary prose, and no formatter can tell them apart.
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

/**
 * Best-effort masking of secret-shaped values in prose (the reason) and as a
 * change-detector for operations. NOT DLP; see the file header.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_BEARER, '$1[redacted]')
    .replace(SECRET_PS_FLAG, '$1[redacted]')
    .replace(SECRET_KEY_VALUE, '$1$2[redacted]')
    .replace(SECRET_TOKEN, '[redacted]');
}

const IDENTITY = (s: string): string => s;

/** Translate known gate reasons only; never rewrite tool arguments or unknown prose. */
export function approvalReasonSpanish(reason: string): string {
  const reasons: Record<string, string> = {
    'touches money or credentials': 'Afecta a dinero o credenciales',
    'installs a tool the agent built itself': 'Instala una herramienta creada por el asistente',
    'activates days of autonomous work on a goal':
      'Activa varios días de trabajo autónomo para un objetivo',
    'starts an approved errand with real-world effects':
      'Inicia una tarea aprobada con efectos reales',
    'pre-payment stage of a purchase flow': 'Es un paso previo al pago de una compra',
    'reads a credential store': 'Lee un almacén de credenciales',
    'touches a password, code or card field': 'Afecta a un campo de contraseña, código o tarjeta',
    'the page element sends, publishes, deletes or books something':
      'El elemento envía, publica, borra o reserva algo',
    'drives the desktop': 'Controla el escritorio',
    'destructive or privilege-raising shell command':
      'Es un comando destructivo o que eleva privilegios',
    'runs a shell command': 'Ejecuta un comando de terminal',
    'not on the allow list': 'No está en la lista de acciones permitidas',
  };
  return Object.hasOwn(reasons, reason) ? reasons[reason]! : reason;
}

export function formatApproval(call: ToolCall, reason: string): ApprovalText {
  reason = approvalReasonSpanish(reason);
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
    // Bounded by construction (300 + 700 + reason); the reason is prose, not the
    // operation, so masking it hides nothing the click would do.
    const question = raw.replace(`Motivo: ${reason}`, `Motivo: ${redactSecrets(reason)}`);
    return withinBudget(raw, question, 'browser');
  }
  if (call.tool === 'shell') {
    const command = typeof call.args.command === 'string' ? call.args.command.trim() : '';
    // The mask is a change-detector here: if it would alter the command, the
    // masked rendering is not the command, and approving it is approving blind.
    if (command && redactSecrets(command) !== command) return deniedAltered('shell');
    const question = [
      '¿Permito shell?',
      command ? `Comando:\n${command}` : 'Comando: (vacío)',
      `Motivo: ${redactSecrets(reason)}`,
    ].join('\n');
    return withinBudget(question, question, 'shell');
  }
  if (call.tool === 'computer') {
    if (call.args.action === 'batch' && Array.isArray(call.args.actions)) {
      const steps = call.args.actions as Array<Record<string, unknown>>;
      if (steps.some((s) => s.action === 'type' && s.secret === true)) return deniedSecretType();
      const rawSteps = steps.map((s, i) => `  ${i + 1}. ${describeComputerAction(s, IDENTITY)}`);
      const shownSteps = steps.map(
        (s, i) => `  ${i + 1}. ${describeComputerAction(s, redactSecrets)}`,
      );
      if (rawSteps.join('\n') !== shownSteps.join('\n')) return deniedAltered('computer');
      const question = [
        '¿Permito computer?',
        `Lote de ${steps.length} acciones:`,
        ...shownSteps,
        `Motivo: ${redactSecrets(reason)}`,
      ].join('\n');
      const raw = [
        '¿Permito computer?',
        `Lote de ${steps.length} acciones:`,
        ...rawSteps,
        `Motivo: ${reason}`,
      ].join('\n');
      return withinBudget(raw, question, 'computer');
    }
    if (call.args.action === 'type' && call.args.secret === true) return deniedSecretType();
    const rawAction = describeComputerAction(call.args, IDENTITY);
    const shownAction = describeComputerAction(call.args, redactSecrets);
    if (rawAction !== shownAction) return deniedAltered('computer');
    const question = [
      '¿Permito computer?',
      `Acción: ${shownAction}`,
      `Motivo: ${redactSecrets(reason)}`,
    ].join('\n');
    const raw = ['¿Permito computer?', `Acción: ${rawAction}`, `Motivo: ${reason}`].join('\n');
    return withinBudget(raw, question, 'computer');
  }
  const raw = `¿Permito ${call.tool}?\n${reason}`;
  return withinBudget(raw, `¿Permito ${call.tool}?\n${redactSecrets(reason)}`, call.tool);
}

/** Back-compat: same text as before for callers that only need the question. */
export function formatApprovalQuestion(call: ToolCall, reason: string): string {
  return formatApproval(call, reason).question;
}

/**
 * The mask would change the operation: deny instead of showing an altered
 * rendering. Denying some legitimate actions beats approving a hidden one.
 */
function deniedAltered(tool: string): ApprovalText {
  return {
    question:
      `¿Permito ${tool}?\n` +
      'La acción contiene algo con forma de secreto. No se muestra enmascarada ' +
      'porque enmascarar puede ocultar parte de la operación (p. ej. PowerShell ' +
      'ejecuta subexpresiones $() dentro de comillas dobles, y los escapes no se ' +
      'parsean), y aprobar una versión alterada es aprobar a ciegas: queda ' +
      'DENEGADA. Ejecútala a mano o reescríbela sin secretos literales.',
    complete: false,
  };
}

/**
 * A type flagged `secret: true`: showing the value would leak it and hiding it
 * would be a blind approval, so it is denied until a vault flow can reference
 * the secret without showing it. The user is never asked to paste the secret.
 */
function deniedSecretType(): ApprovalText {
  return {
    question:
      '¿Permito computer?\n' +
      'La acción escribe un secreto (secret: true) y eso no se aprueba con una ' +
      'pregunta: mostrarlo lo expondría y ocultarlo sería aprobar a ciegas. ' +
      'Queda DENEGADA hasta que exista un flujo de vault que lo referencie sin ' +
      'enseñarlo.',
    complete: false,
  };
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
  'action',
  'x',
  'y',
  'toX',
  'toY',
  'text',
  'key',
  'button',
  'clicks',
  'roi',
  'actions',
  '_target',
]);

function describeComputerAction(
  args: Record<string, unknown>,
  redact: (s: string) => string,
): string {
  const action = typeof args.action === 'string' ? args.action : '?';
  let base: string;
  switch (action) {
    case 'type':
      base = `escribir "${redact(String(args.text ?? ''))}"`;
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
      // Unknown action: nothing hidden — the whole payload is the description.
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

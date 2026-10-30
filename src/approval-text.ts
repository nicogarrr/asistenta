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
  return Object.hasOwn(reasons, reason) ? (reasons[reason] ?? reason) : reason;
}

export function formatApproval(
  call: ToolCall,
  reason: string,
  opts: { showArgs?: boolean; grantWindowMs?: number } = {},
): ApprovalText {
  const showArgs = opts.showArgs ?? true;
  reason = approvalReasonSpanish(reason);
  const target = typeof call.args._target === 'string' ? call.args._target : '';
  if (call.tool === 'browser' && target) {
    const [withCtx = '', ...rest] = target.split('\nRESUMEN DE LA PÁGINA:\n');
    const [element = '', ...ctxParts] = withCtx.split('\nCONTEXTO DEL ELEMENTO:\n');
    const context = ctxParts.join('\n').trim();
    const summary = rest.join('\n').trim();
    const shown = element.split(' | ').filter(Boolean).slice(0, 6).join(' · ').slice(0, 300);
    // Lo que el clic o el relleno VA A HACER (acción, texto a escribir, opción,
    // clave del vault) también se enseña: sin esto, aprobar «rellenar IBAN» no
    // decía qué IBAN se escribía.
    const params = showArgs ? describeArgs(call.args, ['_target']) : '';
    if (params && (redactSecrets(params) !== params || hasInvisible(params))) {
      return deniedAltered('browser');
    }
    const raw = [
      `¿Permito esta acción en el navegador?`,
      `Elemento: ${shown}`,
      context ? `Parte de: ${context.slice(0, 300)}` : '',
      summary ? `Datos de la página:\n${summary.slice(0, 700)}` : '',
      params ? `Parámetros:\n${params}` : '',
      `Motivo: ${reason}`,
    ]
      .filter(Boolean)
      .join('\n');
    // Bounded by construction (300 + 300 + 700 + reason); the reason is prose, not the
    // operation, so masking it hides nothing the click would do.
    const question = raw.replace(`Motivo: ${reason}`, `Motivo: ${redactSecrets(reason)}`);
    return withinBudget(raw, question, 'browser');
  }
  if (call.tool === 'shell') {
    const command = typeof call.args.command === 'string' ? call.args.command.trim() : '';
    // The mask is a change-detector here: if it would alter the command, the
    // masked rendering is not the command, and approving it is approving blind.
    if (command && redactSecrets(command) !== command) return deniedAltered('shell');
    // Un carácter invisible o de control bidi hace que el texto que se lee no sea
    // el comando que se ejecuta (U+202E invierte lo que sigue en pantalla).
    if (hasInvisible(command)) return deniedInvisible('shell');
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
      if (hasInvisible(JSON.stringify(steps))) return deniedInvisible('computer');
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
      return withGrantWindowNote(withinBudget(raw, question, 'computer'), opts.grantWindowMs);
    }
    if (call.args.action === 'type' && call.args.secret === true) return deniedSecretType();
    if (hasInvisible(JSON.stringify(call.args))) return deniedInvisible('computer');
    const rawAction = describeComputerAction(call.args, IDENTITY);
    const shownAction = describeComputerAction(call.args, redactSecrets);
    if (rawAction !== shownAction) return deniedAltered('computer');
    const question = [
      '¿Permito computer?',
      `Acción: ${shownAction}`,
      `Motivo: ${redactSecrets(reason)}`,
    ].join('\n');
    const raw = ['¿Permito computer?', `Acción: ${rawAction}`, `Motivo: ${reason}`].join('\n');
    return withGrantWindowNote(withinBudget(raw, question, 'computer'), opts.grantWindowMs);
  }
  if (call.tool === 'write' || call.tool === 'edit') {
    // Escribir a ciegas no es aprobar: la pregunta enseña la ruta y lo que se va a
    // escribir. El contenido se recorta (un fichero grande no cabe en un chat),
    // pero la ruta y el tamaño total siempre están.
    const path = typeof call.args.path === 'string' ? call.args.path : '';
    const body =
      call.tool === 'write'
        ? typeof call.args.content === 'string'
          ? call.args.content
          : ''
        : [
            typeof call.args.oldString === 'string' ? `- ${call.args.oldString}` : '',
            typeof call.args.newString === 'string' ? `+ ${call.args.newString}` : '',
            typeof call.args.old === 'string' ? `- ${call.args.old}` : '',
            typeof call.args.new === 'string' ? `+ ${call.args.new}` : '',
          ]
            .filter(Boolean)
            .join('\n');
    const PREVIEW = 1200;
    const preview =
      body.length > PREVIEW
        ? `${body.slice(0, PREVIEW)}\n… (${body.length} caracteres en total)`
        : body;
    const question = [
      `¿Permito ${call.tool === 'edit' ? 'editar' : 'escribir'}?`,
      path ? `Archivo: ${path}` : 'Archivo: (sin ruta)',
      preview ? `Contenido:\n${preview}` : 'Contenido: (vacío)',
      `Motivo: ${redactSecrets(reason)}`,
    ].join('\n');
    return { question, complete: true };
  }
  // Cualquier otra herramienta (descargas, servicios, objetivos, checkout, MCP...)
  // enseña TODOS sus parámetros: antes la pregunta era solo «¿Permito download?» y
  // se aprobaba sin ver la URL, la ruta ni el importe.
  const params = showArgs ? describeArgs(call.args, []) : '';
  if (params && (redactSecrets(params) !== params || hasInvisible(params))) {
    return deniedAltered(call.tool);
  }
  const tail = params ? `\nParámetros:\n${params}` : '';
  const raw = `¿Permito ${call.tool}?\n${reason}${tail}`;
  return withinBudget(raw, `¿Permito ${call.tool}?\n${redactSecrets(reason)}${tail}`, call.tool);
}

/** Format, bidi and zero-width characters: what is read is not what runs. */
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/u;

function hasInvisible(text: string): boolean {
  return INVISIBLE.test(text);
}

/**
 * One line per parameter, sorted, the value as JSON (control characters escaped).
 * Nothing is cut: the caller's budget decides whether the whole thing fits.
 */
function describeArgs(args: Record<string, unknown>, skip: string[]): string {
  return Object.keys(args)
    .filter((k) => !skip.includes(k) && args[k] !== undefined)
    .sort()
    .map((k) => `  ${k}: ${JSON.stringify(args[k]) ?? String(args[k])}`)
    .join('\n');
}

function deniedInvisible(tool: string): ApprovalText {
  return {
    question:
      `¿Permito ${tool}?\n` +
      'La acción contiene caracteres invisibles o de control de dirección (bidi), ' +
      'que hacen que lo que se lee no sea lo que se ejecuta: queda DENEGADA. ' +
      'Reescríbela sin esos caracteres.',
    complete: false,
  };
}

/** Back-compat: same text as before for callers that only need the question. */
export function formatApprovalQuestion(call: ToolCall, reason: string): string {
  return formatApproval(call, reason).question;
}

/**
 * Condiciones que NINGUNA aprobación puede cubrir: escribir un secreto, una
 * operación que el enmascarado alteraría, o una acción tan larga que no cabe en
 * una revisión segura. El Gate las consulta ANTES de scopes y fullControl para
 * que "Siempre" no se convierta en "aprueba a ciegas". Devuelve la explicación,
 * o null si la acción sí se puede aprobar con una pregunta.
 */
export function unapprovableOperation(call: ToolCall): string | null {
  // Sin los parámetros genéricos: que un `memory` o un `delegate` libres lleven un
  // texto largo no los vuelve inaprobables; eso solo se decide al preguntar.
  const text = formatApproval(call, '', { showArgs: false });
  return text.complete ? null : text.question;
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
/**
 * Ventana de confianza que abre una aprobación de `computer` en el daemon
 * (Gate.grantWindowMs). La pregunta lo dice: aprobar un clic da 90 s de
 * teclado y ratón sin volver a preguntar, y Nico tiene que saberlo al pulsar «Sí».
 */
export const COMPUTER_GRANT_WINDOW_MS = 90_000;

/** Añade a una pregunta de `computer` aprobable el aviso de la ventana de confianza. */
function withGrantWindowNote(
  text: ApprovalText,
  windowMs: number = COMPUTER_GRANT_WINDOW_MS,
): ApprovalText {
  if (!text.complete || windowMs <= 0) return text;
  const secs = Math.round(windowMs / 1000);
  return {
    ...text,
    question:
      `${text.question}\n` +
      `Si lo apruebas, durante ${secs} s los siguientes clics y teclas de esta tarea ` +
      'no volverán a preguntar (los atajos del sistema como Win+R, Ctrl+Alt o Alt+F4 ' +
      'sí preguntan siempre).',
  };
}

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

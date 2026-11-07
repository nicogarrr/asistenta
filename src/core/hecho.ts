/**
 * Revisor del «hecho» (idea de POKI, reescrita en nuestras palabras): antes de que
 * Asistenta le diga a Nico que algo está hecho, se mira el rastro del propio turno.
 * Si la última acción que cambiaba algo falló o dejó un aviso («el clic no cambió la
 * página», «la selección no se pudo comprobar», «el campo no quedó con el valor») y
 * nadie lo miró después, el «hecho» no está comprobado y la respuesta lo dice.
 *
 * Es gratis: no llama a ningún modelo ni abre nada, solo lee lo que ya pasó. Se apaga
 * con PA_VERIFICAR_HECHO=0.
 */
import type { RunStep } from '../skills/lessons.js';

/** Acciones que solo miran: no cambian nada, y sirven para comprobar lo anterior. */
const READ_ACTIONS = new Set([
  'snapshot',
  'screenshot',
  'look',
  'mirar',
  'read',
  'leer',
  'wait',
  'wait_for',
  'state',
  'status',
  'estado',
  'list',
  'listar',
  'get',
  'search',
  'buscar',
  'find',
  'capture',
  'captura',
  'ocr',
]);

/** Herramientas que solo leen o hablan: nunca son «la acción que hizo la tarea». */
const READ_TOOLS = new Set([
  'done',
  'web',
  'fetch',
  'weather',
  'memory',
  'skills',
  'cargar_herramienta',
  'festivos',
  'divisas',
  'trafico',
  'gasolineras',
  'luz',
  'aire',
  'boe',
]);

/**
 * Avisos que dejan las herramientas cuando algo NO quedó como se pidió. El texto es el
 * motivo que se le cuenta a Nico, en castellano llano.
 */
const WARNINGS: Array<[RegExp, string]> = [
  [/SIN_CAMBIOS/, 'el último clic no cambió la página'],
  [/SELECCION_NO_CORROBORADA/, 'la página no mostró lo que se eligió'],
  [/^\s*RECHAZADO:/m, 'el campo no se rellenó (la página no era la esperada)'],
  [/^\s*ATENCI[ÓO]N:/m, 'un campo no quedó comprobado'],
  [/\bNo he hecho clic\b/, 'el clic no se llegó a hacer'],
];

/** El aviso que deja el resultado de una herramienta, o '' si no hay ninguno. */
export function stepWarning(resultText: string): string {
  if (!resultText) return '';
  for (const [pattern, reason] of WARNINGS) if (pattern.test(resultText)) return reason;
  return '';
}

const CLAIM =
  /(?<![\p{L}\p{N}])(?:hecho(?! de)|listo|ya est[aá]|terminad[oa]|completad[oa]|he (?:a[ñn]adido|enviado|mandado|comprado|pedido|reservado|creado|guardado|puesto|cambiado|borrado|apuntado|rellenado|pagado|hecho|completado|activado|desactivado|programado|subido|publicado|cancelado|quitado|metido|seleccionado|elegido|marcado)|a[ñn]adid[oa]s? al carrito|enviad[oa] correctamente)(?![\p{L}\p{N}])/iu;

/** Una respuesta que ya avisa de que no lo consiguió no necesita otro aviso. */
const ADMITS =
  /(?<![\p{L}\p{N}])(?:no (?:he podido|pude|he conseguido|consegu[ií]|lo he|est[aá] hecho|ha funcionado|funcion[oó]|se ha (?:podido|hecho))|no lo (?:he )?(?:podido|conseguido)|sin comprobar|no (?:est[aá]|lo tengo) comprobado|no he podido comprobar)(?![\p{L}\p{N}])/iu;

/** ¿La respuesta dice que la tarea está hecha (y no lo matiza ya)? */
export function claimsDone(text: string): boolean {
  if (!text) return false;
  return CLAIM.test(text) && !ADMITS.test(text);
}

function isRead(step: RunStep): boolean {
  return READ_TOOLS.has(step.tool) || READ_ACTIONS.has(step.action);
}

/**
 * Por qué el «hecho» de este turno no está comprobado, o null si está bien.
 *
 * Se mira la ÚLTIMA acción que cambiaba algo. Si salió bien y sin aviso, vale. Si
 * falló o dejó aviso, vale solo si después se miró con la misma herramienta (un
 * snapshot, una captura): el modelo vio el resultado y su «hecho» se basa en eso.
 */
export function unverifiedDone(text: string, steps: readonly RunStep[]): string | null {
  if (!claimsDone(text)) return null;
  let last = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step && !isRead(step)) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const step = steps[last] as RunStep;
  const problem = !step.ok
    ? `la última acción (${step.tool}${step.action ? ` · ${step.action}` : ''}) dio error`
    : step.warn
      ? step.warn
      : '';
  if (!problem) return null;
  const lookedAfter = steps.slice(last + 1).some((s) => s.tool === step.tool && s.ok && isRead(s));
  return lookedAfter ? null : problem;
}

/** La línea honesta que se añade a la respuesta cuando el «hecho» no está comprobado. */
export function unverifiedDoneLine(reason: string): string {
  return `⚠️ Ojo, no lo he podido comprobar: ${reason}. Míralo antes de darlo por hecho, o pídeme que lo revise.`;
}

/** ¿Está encendido el revisor? (PA_VERIFICAR_HECHO=0 lo apaga.) */
export function doneCheckOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_VERIFICAR_HECHO ?? '').trim() !== '0';
}

/**
 * La línea que hay que añadir a la respuesta de un turno, o null. Solo turnos que
 * terminaron bien (un turno con error ya lo dice a su manera).
 */
export function doneCheckLine(
  result: { text: string; error: string | null; steps: readonly RunStep[] },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!doneCheckOn(env) || result.error !== null) return null;
  const reason = unverifiedDone(result.text, result.steps);
  return reason ? unverifiedDoneLine(reason) : null;
}

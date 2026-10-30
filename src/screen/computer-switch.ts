/**
 * `/ordenador [on|off]`: the Computer Use kill switch (`PA_COMPUTER_USE`) flipped
 * at runtime from Telegram, without editing `.env` or restarting.
 *
 * Owner only, in his private chat — anyone else gets a refusal and nothing
 * changes. `createComputerTool` reads `config.computerUse` on every call, so
 * «off» refuses the very next action (screenshots included).
 *
 * «off» is saved (`ordenador-off.json` in the state dir) so a restart keeps it
 * off; «on» removes the file and a restart goes back to what `.env` says.
 * `PA_COMPUTER_USE=0` in `.env` always wins. Only stricter: a file that cannot
 * be removed leaves the PC off after a restart, never the other way round.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uniqueTmpPath } from '../fs-tmp.js';
import { foldAccents } from '../text.js';

/** Name of the saved «off» inside the state dir (registered in src/state-files.ts). */
export const COMPUTER_OFF_FILE = 'ordenador-off.json';

/** True when a previous /ordenador off was saved: the daemon starts with Computer Use off. */
export function computerOffSaved(stateDir: string): boolean {
  return existsSync(join(stateDir, COMPUTER_OFF_FILE));
}

/** Saves «off» (atomic write) or removes it for «on». Throws if the disk refuses. */
export function saveComputerSwitch(stateDir: string, on: boolean): void {
  const file = join(stateDir, COMPUTER_OFF_FILE);
  if (on) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(stateDir, { recursive: true });
  const tmp = uniqueTmpPath(file);
  writeFileSync(tmp, `${JSON.stringify({ off: true, at: new Date().toISOString() })}\n`);
  renameSync(tmp, file);
}

export interface ComputerSwitchDeps {
  isOwner: boolean;
  enabled: () => boolean;
  set: (on: boolean) => void;
  /** Saves the choice across restarts; absent = in memory only (old behaviour). */
  save?: (on: boolean) => void;
  /** True when an «off» is saved on disk; absent = /ordenador estado says nothing about it. */
  offSaved?: () => boolean;
}

/** Second line of /ordenador estado: whether the state survives a restart. */
function savedNote(deps: ComputerSwitchDeps, enabled: boolean): string {
  if (!deps.offSaved) return '';
  let saved: boolean;
  try {
    saved = deps.offSaved();
  } catch {
    return '\nNo he podido mirar si el apagado está guardado.';
  }
  if (saved && !enabled)
    return '\nEl apagado está guardado: sigue apagado aunque se reinicie el asistente.';
  if (saved && enabled) {
    return '\nOjo: queda un apagado guardado; si el asistente se reinicia, arrancará con el control apagado.';
  }
  if (!enabled) return '\nEl apagado no está guardado: al reiniciar vuelve a lo que diga el .env.';
  return '';
}

/** Runs `deps.save`; false when it threw (the in-memory flip still applies). */
function trySave(deps: ComputerSwitchDeps, on: boolean): boolean | undefined {
  if (!deps.save) return undefined;
  try {
    deps.save(on);
    return true;
  } catch {
    return false;
  }
}

// Comparadas ya sin tildes ni mayúsculas (ver switchWord): «apágalo» → «apagalo», «sí» → «si».
const OFF = new Set([
  'off',
  'apagar',
  'apaga',
  'apagado',
  'apagalo',
  'desactivar',
  'desactiva',
  'desactivado',
  'desactivalo',
  'no',
  '0',
  'stop',
]);
const ON = new Set([
  'on',
  'encender',
  'enciende',
  'encendido',
  'enciendelo',
  'activar',
  'activa',
  'activado',
  'activalo',
  'si',
  '1',
]);

/**
 * La palabra de /ordenador comparable: sin tildes, en minúsculas y sin
 * puntuación alrededor («¡Apágalo!» → «apagalo», «off.» → «off»). Una palabra
 * desconocida sigue dando la ayuda; esto no cambia ningún permiso.
 */
function switchWord(args: string): string {
  return foldAccents(args.trim()).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

export const COMPUTER_SWITCH_USAGE = 'Uso: /ordenador ⬦ /ordenador on ⬦ /ordenador off';

export function computerSwitchCommand(args: string, deps: ComputerSwitchDeps): string {
  if (!deps.isOwner) {
    return 'Solo el dueño, en su chat privado, puede encender o apagar el control del ordenador.';
  }
  const word = switchWord(args);
  if (word === '' && args.trim() !== '') return COMPUTER_SWITCH_USAGE;
  if (word === '' || word === 'estado') {
    const enabled = deps.enabled();
    const head = enabled
      ? `🖥️ Control del ordenador: ACTIVADO. Apágalo con /ordenador off.`
      : `🛑 Control del ordenador: DESACTIVADO. Enciéndelo con /ordenador on.`;
    return `${head}${savedNote(deps, enabled)}`;
  }
  if (OFF.has(word)) {
    deps.set(false);
    const saved = trySave(deps, false);
    const head =
      '🛑 Control del ordenador desactivado: no veo ni toco el escritorio (ni capturas) hasta /ordenador on.';
    if (saved === true) return `${head} Sigue apagado aunque se reinicie el asistente.`;
    if (saved === false) {
      return `${head} No he podido guardarlo en disco: si el asistente se reinicia, vuelve a lo que diga el .env.`;
    }
    return `${head} Al reiniciar vuelve a lo que diga el .env.`;
  }
  if (ON.has(word)) {
    deps.set(true);
    const saved = trySave(deps, true);
    const head =
      '✅ Control del ordenador activado: puedo volver a ver y usar el escritorio, siempre pidiendo permiso como hasta ahora.';
    if (saved === false) {
      return `${head} No he podido borrar el apagado guardado: si el asistente se reinicia, arrancará con el control apagado.`;
    }
    return `${head} Al reiniciar vuelve a lo que diga el .env.`;
  }
  return COMPUTER_SWITCH_USAGE;
}

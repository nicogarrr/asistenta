/**
 * `/ordenador [on|off]`: the Computer Use kill switch (`PA_COMPUTER_USE`) flipped
 * at runtime from Telegram, without editing `.env` or restarting.
 *
 * Owner only, in his private chat — anyone else gets a refusal and nothing
 * changes. The flip lives in memory: a restart goes back to what `.env` says,
 * and the reply says so. `createComputerTool` reads `config.computerUse` on
 * every call, so «off» refuses the very next action (screenshots included).
 */
export interface ComputerSwitchDeps {
  isOwner: boolean;
  enabled: () => boolean;
  set: (on: boolean) => void;
}

const OFF = new Set(['off', 'apagar', 'apaga', 'desactivar', 'desactiva', 'no', '0', 'stop']);
const ON = new Set(['on', 'encender', 'enciende', 'activar', 'activa', 'si', 'sí', '1']);

export const COMPUTER_SWITCH_USAGE = 'Uso: /ordenador ⬦ /ordenador on ⬦ /ordenador off';

export function computerSwitchCommand(args: string, deps: ComputerSwitchDeps): string {
  if (!deps.isOwner) {
    return 'Solo el dueño, en su chat privado, puede encender o apagar el control del ordenador.';
  }
  const word = args.trim().toLowerCase();
  if (word === '' || word === 'estado') {
    return deps.enabled()
      ? `🖥️ Control del ordenador: ACTIVADO. Apágalo con /ordenador off.`
      : `🛑 Control del ordenador: DESACTIVADO. Enciéndelo con /ordenador on.`;
  }
  if (OFF.has(word)) {
    deps.set(false);
    return '🛑 Control del ordenador desactivado: no veo ni toco el escritorio (ni capturas) hasta /ordenador on. Al reiniciar vuelve a lo que diga el .env.';
  }
  if (ON.has(word)) {
    deps.set(true);
    return '✅ Control del ordenador activado: puedo volver a ver y usar el escritorio, siempre pidiendo permiso como hasta ahora. Al reiniciar vuelve a lo que diga el .env.';
  }
  return COMPUTER_SWITCH_USAGE;
}

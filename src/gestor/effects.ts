/**
 * The effect classes of the universal errand runner (capability 3, GESTOR
 * UNIVERSAL). Every step of the plan Nico approves declares the worst thing it
 * may do in the world, and the plan shows the class next to each step. While a
 * gestión is active, the Gate compares each call against the class of the
 * current step: a call that exceeds it - or whose class cannot be PROVEN -
 * asks Nico again, past every memo, scope, grant window and fullControl.
 * "Exceeds" is decided here, once, as a small explicit table - never by
 * proximity or inference.
 */
export type EffectClass = 'lee' | 'escribe-local' | 'envia-terceros' | 'paga' | 'destructivo';

export const EFFECT_CLASSES: readonly EffectClass[] = [
  'lee',
  'escribe-local',
  'envia-terceros',
  'paga',
  'destructivo',
];

/** The plan Nico reads is in Spanish; so are its per-step effect labels. */
export const EFFECT_LABEL: Record<EffectClass, string> = {
  lee: 'solo lectura',
  'escribe-local': 'escribe en tu PC',
  'envia-terceros': 'envía a terceros',
  paga: 'paga',
  destructivo: 'destructivo',
};

/**
 * Whether a step approved as `step` covers a call classified as `call`.
 * The declared contract, in full: reading is always covered; a paying step
 * also covers sending (the charge click itself sends); everything else is
 * covered only by its own class. An approved "envía a terceros" does NOT
 * license local writes, a "destructivo" does NOT license sending, and a class
 * that cannot be proven (null) is never covered - see effectOverrideReason.
 */
export function effectCovered(call: EffectClass, step: EffectClass): boolean {
  switch (call) {
    case 'lee':
      return true;
    case 'escribe-local':
      return step === 'escribe-local';
    case 'envia-terceros':
      return step === 'envia-terceros' || step === 'paga';
    case 'paga':
      return step === 'paga';
    case 'destructivo':
      return step === 'destructivo';
  }
}

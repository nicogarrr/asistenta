/**
 * F7 /modelo: ver o elegir el modelo de una conversación entre los
 * configurados (PA_MODEL y PA_FALLBACK_MODEL). Solo texto y parseo; el cambio
 * real lo hace PersonalAgent.chooseModel.
 */

export type ModeloAction =
  | { kind: 'show' }
  | { kind: 'set'; id: string | undefined }
  | { kind: 'error'; text: string };

const BACK_TO_PRIMARY = new Set(['normal', 'principal', 'reset', 'defecto', 'por defecto']);

/** `/modelo`, `/modelo 2`, `/modelo <nombre>` o `/modelo normal`. */
export function parseModelo(args: string, available: readonly string[]): ModeloAction {
  const raw = args.trim();
  if (raw === '') return { kind: 'show' };
  const lower = raw.toLowerCase();
  if (BACK_TO_PRIMARY.has(lower)) return { kind: 'set', id: undefined };
  if (/^\d+$/.test(raw)) {
    const id = available[Number(raw) - 1];
    return id
      ? { kind: 'set', id }
      : { kind: 'error', text: `No hay modelo ${raw}. Escribe /modelo para ver la lista.` };
  }
  const id = available.find((m) => m === raw) ?? available.find((m) => m.toLowerCase() === lower);
  if (id) return { kind: 'set', id };
  return {
    kind: 'error',
    text: `«${raw.slice(0, 60)}» no está entre los modelos configurados. Escribe /modelo para ver la lista.`,
  };
}

/** Lista numerada con el modelo actual marcado. El primero es siempre PA_MODEL. */
export function formatModelos(available: readonly string[], current: string): string {
  const lines = [`Modelo de esta conversación: ${current}`, ''];
  available.forEach((id, i) => {
    const mark = id === current ? '✓' : ' ';
    lines.push(`${mark} ${i + 1}. ${id}${i === 0 ? ' (principal)' : ''}`);
  });
  lines.push('');
  if (available.length < 2) {
    lines.push('Solo hay un modelo configurado. Pon PA_FALLBACK_MODEL en .env para tener otro.');
  } else {
    lines.push('Cambia con /modelo <número|nombre>; /modelo normal vuelve al principal.');
  }
  lines.push('Solo afecta a esta conversación y dura hasta que reinicie.');
  return lines.join('\n');
}

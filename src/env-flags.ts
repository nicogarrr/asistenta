/**
 * Interruptores del .env que no tienen que ver con la seguridad. Antes solo se
 * encendían con «1»: quien escribía «sí», «true» u «on» se quedaba con la función
 * apagada sin saber por qué. Aquí se leen como lo escribiría una persona, y
 * `pa doctor` avisa de los valores que no se entienden.
 *
 * Los interruptores de seguridad (PA_CORREO_CANAL, PA_QA_CHANNEL,
 * PA_QA_OWNER_DM, PA_SPEAKER_VERIFY, PA_TAINT_GATE) NO pasan por aquí: siguen
 * aceptando solo su valor exacto.
 */

const SI = new Set(['1', 'si', 'true', 'yes', 'on', 'activado', 'activo']);
const NO = new Set(['0', 'no', 'false', 'off', 'apagado', 'desactivado']);

const plain = (v: string | undefined) =>
  (v ?? '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

/** Interruptor normal del .env: sí/no como lo escribe una persona; vacío o raro → por defecto. */
export function envSwitch(value: string | undefined, byDefault: boolean): boolean {
  const v = plain(value);
  if (SI.has(v)) return true;
  if (NO.has(v)) return false;
  return byDefault;
}

/** Interruptores que `pa doctor` revisa (solo los que no son de seguridad). */
export const ENV_SWITCHES: ReadonlyArray<{ name: string; byDefault: boolean }> = [
  { name: 'PA_SEMANTIC_RECALL', byDefault: false },
  { name: 'PA_MEMORY_CONSOLIDATE', byDefault: false },
];

/** Lee un interruptor de ENV_SWITCHES con su valor por defecto. */
export function envSwitchOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const spec = ENV_SWITCHES.find((s) => s.name === name);
  return envSwitch(env[name], spec?.byDefault ?? false);
}

const shown = (v: string) => v.replace(/[^\p{L}\p{N} :.,_-]/gu, '').slice(0, 30);

/** Línea de `pa doctor` solo si algún interruptor tiene un valor que no se entiende. */
export function envSwitchesDoctorLine(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const bad = ENV_SWITCHES.filter(({ name }) => {
    const v = plain(env[name]);
    return v !== '' && !SI.has(v) && !NO.has(v);
  }).map(({ name }) => `${name} «${shown((env[name] ?? '').trim())}»`);
  if (bad.length === 0) return undefined;
  return `ajustes         no entiendo ${bad.join(', ')}: pon 1 para activarlo o 0 para apagarlo`;
}

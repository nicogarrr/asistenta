/**
 * PA_TIMEZONE mal puesta en el .env (p. ej. «Madrid» o «GMT+1») solo dejaba una
 * línea en inglés en la consola y Asistenta seguía con la hora del PC: los
 * recordatorios podían saltar a otra hora sin que el dueño supiera por qué.
 * Aquí se dice en castellano, en `pa doctor` y una vez por Telegram al arrancar.
 */

/** La zona escrita en el .env, si hay una y no es válida. */
export function invalidTimeZone(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.PA_TIMEZONE?.trim();
  if (!configured) return null;
  try {
    new Intl.DateTimeFormat('es-ES', { timeZone: configured });
    return null;
  } catch {
    return configured;
  }
}

/** Línea de `pa doctor` para la zona horaria. */
export function timeZoneDoctorLine(env: NodeJS.ProcessEnv = process.env): string {
  const bad = invalidTimeZone(env);
  if (bad !== null) {
    const shown = bad.replace(/[^\p{L}\p{N}/_+:.-]/gu, '').slice(0, 40);
    return `zona horaria    PA_TIMEZONE «${shown}» no vale: pon por ejemplo Europe/Madrid en el archivo .env (mientras, uso la hora del PC)`;
  }
  const zone = env.PA_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `zona horaria    ${zone}`;
}

/** Los problemas del arranque más «zona-horaria» si PA_TIMEZONE no vale. */
export function withTimeZoneProblem<T extends string>(
  problems: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): (T | 'zona-horaria')[] {
  return invalidTimeZone(env) === null ? [...problems] : [...problems, 'zona-horaria'];
}

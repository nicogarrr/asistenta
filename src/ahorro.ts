/**
 * Modo ahorro (`PA_AHORRO=1` en el `.env`): Asistenta gasta menos a cambio de reaccionar un
 * poco más despacio en lo que no se usa a menudo. Apagado por defecto.
 * - Palabra de activación: comprueba cada 3 s con ventana de 4,5 s (wake.ts, `wakeTiming`).
 * - Navegador sin ventana: se cierra a los 3 min sin uso en vez de 10 (browser/service.ts).
 * - Modelo grande de notas de voz: sale de la RAM a los 2 min sin notas en vez de 10 (stt.ts).
 */
export function modoAhorro(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'on', 'si', 'sí'].includes((env.PA_AHORRO ?? '').trim().toLowerCase());
}

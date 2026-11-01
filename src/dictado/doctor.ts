/** Línea «dictado» de `pa doctor`: si está listo y, si no, qué falta en una frase. */

import { ajustesDictado } from './ajustes.js';

export function dictadoDoctorLine(
  env: NodeJS.ProcessEnv = process.env,
  plataforma: NodeJS.Platform = process.platform,
  escritorio = true,
): string {
  const a = ajustesDictado(env);
  const linea = (t: string) => `dictado         ${t}`;
  if (!a.activo)
    return linea('apagado (PA_DICTADO=1 para dictar en cualquier app; ver docs/dictado.md)');
  if (plataforma !== 'win32') return linea('encendido, pero solo funciona en Windows');
  if (!escritorio) return linea('encendido, pero con PA_DESKTOP=off no puedo escribir en tus apps');
  if (!a.tecla) {
    return linea(
      `no entiendo PA_DICTADO_TECLA «${a.teclaTexto.slice(0, 30)}»: usa por ejemplo ctrl+win`,
    );
  }
  const uso =
    a.modo === 'alternar'
      ? `pulsa ${a.teclaTexto} para empezar y otra vez para terminar`
      : `mantén ${a.teclaTexto}, habla y suelta`;
  return linea(`listo: ${uso}; Esc descarta (prueba el micro con: pa dictado prueba)`);
}

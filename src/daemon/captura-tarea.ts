/**
 * «Pásame una captura cuando lo tengas» mientras Asistenta ya está con una tarea.
 *
 * Gertru (el asistente de @XMihura) lo hace bien: sigue con la búsqueda de Renfe y al
 * acabar manda la captura de la lista de trenes. Aquí fallaban dos cosas:
 * - con la conversación principal ocupada, ese mensaje abría una conversación nueva sin
 *   contexto («¿captura de qué?»), porque solo «sí»/«vale» seguían la que estaba en marcha;
 * - en el PC con escritorio la captura era SIEMPRE la pantalla, y el navegador de la
 *   tarea va sin ventana: llegaba el escritorio en vez de la página de Renfe.
 */
import { foldAccents } from '../text.js';

/**
 * ¿El mensaje se refiere a la tarea que ya está en marcha («cuando lo tengas», «en cuanto
 * acabes»)? Solo mensajes cortos: uno largo con contenido propio sigue siendo otra petición.
 */
export function sigueLaTareaEnCurso(text: string): boolean {
  const t = foldAccents(text).toLowerCase().trim();
  if (!t || t.length > 120) return false;
  return /\b(cuando|en cuanto|nada mas)\s+(lo |la |los |las )?(tengas|acabes|termines|encuentres|sepas|veas|este|estes)\b|\bal (acabar|terminar)\b/.test(
    t,
  );
}

/**
 * ¿La captura pedida es la de la página de la tarea y no la del escritorio? Sí cuando la
 * conversación tiene una página abierta y el mensaje no nombra el PC ni el escritorio.
 */
export function capturaDeLaPagina(text: string, paginaAbierta: boolean): boolean {
  if (!paginaAbierta) return false;
  const t = foldAccents(text).toLowerCase();
  return !/\b(pc|ordenador|portatil|escritorio|monitor|pantalla entera|pantalla completa)\b/.test(
    t,
  );
}

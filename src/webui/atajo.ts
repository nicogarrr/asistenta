/**
 * Atajos del iPhone (Nico, 7 nov: «tengo un iphone18 pro asi que tengo mucho por donde tirar»).
 *
 * `POST /api/atajo` es la puerta para la app Atajos de iOS: «Oye Siri, pregunta a
 * Asistenta», el botón de acción y «Mandar a Asistenta» desde Compartir. El iPhone ya
 * dicta y ya lee en voz alta, así que aquí no hay whisper ni voz del PC: llega texto y
 * sale texto plano, listo para la acción «Leer texto» sin pasos de JSON.
 *
 * - `modo: 'voz'` (por defecto): respuesta corta para decirla en voz alta.
 * - `modo: 'texto'`: respuesta normal (p. ej. desde Compartir, para leerla en pantalla).
 * - Atajos corta «Obtener contenido de URL» hacia los 60 s. Si el turno pasa del tope
 *   (50 s), contesta al momento que la respuesta irá por Telegram y la manda allí al
 *   terminar: el atajo nunca acaba en un error de tiempo sin decir nada.
 * - Corre en el hilo principal, con la misma memoria y aprobaciones que Telegram.
 */

import { sliceSafe } from '../text.js';

/** Tope de espera antes de pasar la respuesta a Telegram (Atajos corta hacia los 60 s). */
export const ATAJO_TOPE_MS = 50_000;
/** Texto máximo de una petición desde Atajos (un dictado o un enlace compartido). */
export const ATAJO_MAX_TEXTO = 4000;

export type AtajoModo = 'voz' | 'texto';

export function atajoModo(raw: unknown): AtajoModo {
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'texto' ? 'texto' : 'voz';
}

/** Lo que recibe el agente: la petición con una nota de dónde viene y cómo contestar. */
export function atajoPrompt(texto: string, modo: AtajoModo): string {
  if (modo === 'voz') {
    return `[Desde Siri en el iPhone, dictado: contesta en 1 a 3 frases cortas y naturales para decirlas en voz alta, sin listas, tablas, enlaces ni emojis, salvo que pida detalle] ${texto}`;
  }
  return `[Desde el iPhone (Atajos/Compartir): contesta breve, se lee en la pantalla del móvil] ${texto}`;
}

/**
 * Quita el Markdown que el iPhone leería en voz alta como símbolos: **negrita**,
 * `código`, encabezados, viñetas y [enlaces](url) (queda el texto del enlace).
 */
export function textoPlano(md: string): string {
  return md
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\[([^\]]+)\]\((?:https?:[^)\s]+)\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const ATAJO_TARDE =
  'Me está llevando más de lo normal. Te mando la respuesta por Telegram en cuanto la tenga.';
export const ATAJO_TARDE_SIN_TELEGRAM =
  'Me está llevando más de lo normal. Sigo con ello; pregúntame otra vez en un minuto.';
export const ATAJO_FALLO =
  'Perdona, algo ha fallado en el PC y no he podido contestarte. Prueba otra vez o escríbeme por Telegram.';

export interface AtajoDeps {
  chat(texto: string): Promise<{ text: string }>;
  /** Manda un texto al chat privado del dueño en Telegram (respuestas que llegan tarde). */
  avisar?(texto: string): Promise<unknown>;
  topeMs?: number;
}

/** Contesta una petición de Atajos con texto plano; nunca lanza. */
export async function responderAtajo(
  texto: string,
  modo: AtajoModo,
  deps: AtajoDeps,
): Promise<string> {
  const tope = Math.max(0, deps.topeMs ?? ATAJO_TOPE_MS);
  const turno = deps.chat(atajoPrompt(texto, modo)).then(
    (r) => ({ ok: true as const, text: typeof r?.text === 'string' ? r.text : '' }),
    () => ({ ok: false as const, text: '' }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tarde = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), tope);
    timer.unref?.();
  });
  const primero = await Promise.race([turno, tarde]);
  if (timer) clearTimeout(timer);
  if (primero) {
    if (!primero.ok) return ATAJO_FALLO;
    return textoPlano(primero.text) || 'Hecho.';
  }
  const avisar = deps.avisar;
  if (!avisar) return ATAJO_TARDE_SIN_TELEGRAM;
  void turno.then(async (r) => {
    const resumen = texto.length > 80 ? `${sliceSafe(texto, 79)}…` : texto;
    const cuerpo = r.ok ? r.text.trim() || 'Hecho.' : ATAJO_FALLO;
    try {
      await avisar(`📱 Lo que me pediste desde el iPhone («${resumen}»):\n\n${cuerpo}`);
    } catch {
      // Sin Telegram no hay a dónde mandarla; el turno ya quedó en el hilo principal.
    }
  });
  return ATAJO_TARDE;
}

/** El token que manda /atajos se borra solo del chat pasado este tiempo. */
export const ATAJO_TOKEN_BORRAR_MS = 10 * 60_000;

/** La dirección https del panel que da `/panel` (su botón `webapp:<url>`), acabada en «/». */
export function urlPanelDeBotones(
  buttons?: ReadonlyArray<{ label: string; action: string }>,
): string | null {
  const action = buttons?.find((b) => b.action.startsWith('webapp:'))?.action;
  if (!action) return null;
  const url = action.slice('webapp:'.length).trim();
  if (!/^https:\/\/[^\s/]+/.test(url)) return null;
  return url.endsWith('/') ? url : `${url}/`;
}

/** `/atajos` en Telegram: cómo montar los atajos del iPhone con la dirección real del panel. */
export function atajosInstrucciones(panelUrl: string): string {
  const url = `${panelUrl}api/atajo`;
  return [
    '📱 Atajos del iPhone: Siri, botón de acción y Compartir. El iPhone dicta y lee la respuesta, así que va más rápido que /voz. Necesita Tailscale encendido en el móvil.',
    '',
    '1) «Pregunta a Asistenta». En la app Atajos, crea un atajo con 3 acciones:',
    '• Dictar texto',
    `• Obtener contenido de URL: ${url}`,
    '  Método POST. Encabezado Authorization = el token que te mando abajo.',
    '  Cuerpo JSON: text = Texto dictado, modo = voz',
    '• Leer texto: Contenido de la URL',
    'Luego: «Oye Siri, pregunta a Asistenta». Para el botón de acción: Ajustes → Botón de acción → Atajo.',
    '',
    '2) «Mandar a Asistenta» (desde Compartir). Activa «Mostrar en la hoja de compartir» y pon:',
    `• Obtener contenido de URL: la misma, con text = Entrada del atajo y modo = texto`,
    '• Mostrar resultado: Contenido de la URL',
    '',
    'Si tardo más de 50 s, el atajo te dice que la respuesta llega por Telegram, y llega aquí.',
    '🔑 Abajo va el token, tal cual para el encabezado Authorization. Lo borro de este chat en 10 minutos.',
  ].join('\n');
}

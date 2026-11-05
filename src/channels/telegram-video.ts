/**
 * Un vídeo normal (no una nota de vídeo) se oye: su sonido va por el mismo camino que
 * los audios (descarga, transcripción con ffmpeg) y el asistente sabe que es un vídeo.
 * Antes se contestaba «Aún no puedo ver vídeos» y «¿qué dice este vídeo?» se quedaba
 * sin respuesta, aunque la nota de vídeo redonda ya se transcribía.
 *
 * Puro: se prueba sin bot ni red.
 */

/** Lo más grande que deja bajar la Bot API de Telegram (getFile). */
export const VIDEO_HEAR_MAX_BYTES = 20 * 1024 * 1024;

/** Marca para el asistente: lo transcrito es el sonido de un vídeo, no la voz del dueño. */
export const VIDEO_HEARD_MARK = '[Vídeo: no veo la imagen, solo oigo su sonido]';

export interface HearableVideo {
  file_id: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
}

/**
 * El vídeo que se puede oír, o null: sin vídeo, demasiado grande para bajarlo, o un
 * vídeo sin duración (sin sonido que oír). Dentro de un álbum también se oye: antes el
 * álbum solo avisaba «Aún no puedo ver vídeos» aunque el mismo vídeo suelto se oía.
 */
export function videoToHear(msg: object): HearableVideo | null {
  const m = msg as { video?: HearableVideo };
  const video = m.video;
  if (!video || typeof video.file_id !== 'string' || !video.file_id) return null;
  if (typeof video.file_size === 'number' && video.file_size > VIDEO_HEAR_MAX_BYTES) return null;
  if (typeof video.duration === 'number' && video.duration <= 0) return null;
  return video;
}

/**
 * El texto del mensaje con la marca de vídeo: tras la marca de un reenvío (si la hay)
 * y antes del pie que escribió el dueño.
 */
export function withVideoMark(text: string, forwarded?: string): string {
  if (forwarded && text.startsWith(forwarded)) {
    const rest = text.slice(forwarded.length).trim();
    return [forwarded, VIDEO_HEARD_MARK, rest].filter(Boolean).join('\n');
  }
  return [VIDEO_HEARD_MARK, text.trim()].filter(Boolean).join('\n');
}

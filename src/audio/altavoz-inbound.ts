import { isOwnerDm } from '../vigilante.js';
import type { AltavozMode, AltavozPlayer } from './altavoz.js';

/** Lo mínimo de un mensaje entrante que mira el altavoz. */
export interface AltavozInbound {
  channel: string;
  chatId: string;
  userId: string;
  text: string;
  audioFileId?: string;
  audioMimeType?: string;
  /** Resto de audios enviados juntos (álbum): suenan detrás del primero. */
  albumAudios?: ReadonlyArray<{ fileId: string; mimeType?: string }>;
}

export interface AltavozInboundDeps {
  /** Modo del altavoz de este chat (/altavoz pc|tele|off). */
  mode: AltavozMode;
  /** Solo suena en el PC de escritorio (nunca en un servidor sin altavoces). */
  desktop: boolean;
  /** Id de Telegram del dueño: solo sus notas, en su chat privado, suenan. */
  ownerUserId: number | null;
  player: AltavozPlayer;
  /** Descarga la nota (null si no se pudo). */
  download(fileId: string): Promise<Buffer | null>;
  /** Contesta en el chat de la nota. */
  reply(text: string): void;
  /** Chat que la mandó: /stop en ese chat la para. */
  key: string;
}

export type AltavozInboundResult = 'skipped' | 'queued' | 'full';

/**
 * Confirmación corta al encolar la nota, antes de que suene: «Sonando…», no «Sonó» (Nico,
 * 2 nov 23:04), porque si la descarga falla después llega «No he podido soltarla» (modo megáfono, Nico 2 nov 2026: con el
 * altavoz encendido su nota SUENA y nada más; no se transcribe ni se contesta. Para
 * hablarle al asistente: /altavoz off o escribir).
 */
export function altavozConfirmText(mode: 'pc' | 'tele'): string {
  return mode === 'tele' ? '📺 Sonando en la tele…' : '🔊 Sonando…';
}

/**
 * Dónde suena una nota de este mensaje, o null: solo una nota de voz del dueño en su
 * chat privado, con el altavoz encendido, en el PC de escritorio y sin comando.
 */
export function altavozTarget(
  inbound: AltavozInbound,
  deps: Pick<AltavozInboundDeps, 'mode' | 'desktop' | 'ownerUserId'>,
): 'pc' | 'tele' | null {
  if (!inbound.audioFileId || inbound.text.trim().startsWith('/')) return null;
  const { mode } = deps;
  if (mode === 'off' || !deps.desktop || !isOwnerDm(inbound, deps.ownerUserId)) return null;
  return mode;
}

/** PA_ALTAVOZ_VOZ=1: la respuesta a una nota del altavoz también se dice en voz alta. */
export function altavozVoiceReplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PA_ALTAVOZ_VOZ?.trim() === '1';
}

export interface AltavozReplyDeps extends Omit<AltavozInboundDeps, 'download'> {
  /** PA_ALTAVOZ_VOZ (apagado por defecto). */
  enabled: boolean;
  /** Voz de la respuesta (null si el TTS falla o tarda demasiado). */
  speak(): Promise<{ data: Buffer; mimeType: string } | null>;
  onError?: (err: unknown) => void;
}

/**
 * Respuestas más largas que esto (unos 45 s de voz) no se dicen en la tele: un salón
 * entero escuchando una lista larga cansa, y el texto ya está en el chat. En el PC sí.
 */
export const ALTAVOZ_VOZ_TELE_MAX_CHARS = 700;

/**
 * Con PA_ALTAVOZ_VOZ=1, la respuesta a una nota que sonó en el altavoz se dice en el
 * mismo sitio (PC o tele), detrás de la nota en la cola. Se llama DESPUÉS de mandar el
 * texto y no espera a nada: la voz nunca retrasa la respuesta escrita. Un fallo de la
 * voz no avisa en el chat (el texto ya llegó); solo el aviso del firewall de la tele.
 * En la tele, una respuesta de más de ALTAVOZ_VOZ_TELE_MAX_CHARS caracteres no se dice.
 */
export function routeReplyToAltavoz(
  inbound: AltavozInbound,
  replyText: string,
  deps: AltavozReplyDeps,
): AltavozInboundResult {
  if (!deps.enabled || !replyText.trim()) return 'skipped';
  const mode = altavozTarget(inbound, deps);
  if (!mode) return 'skipped';
  if (mode === 'tele' && replyText.trim().length > ALTAVOZ_VOZ_TELE_MAX_CHARS) return 'skipped';
  const queued = deps.player.enqueue(
    mode,
    async () => {
      const spoken = await deps.speak().catch(() => null);
      return spoken ? { bytes: spoken.data, mimeType: spoken.mimeType } : null;
    },
    (err) => deps.onError?.(err),
    deps.key,
    (text) => deps.reply(text),
  );
  return queued ? 'queued' : 'full';
}

/**
 * Altavoz: una nota de voz del dueño, en su chat privado, suena sola en el PC o la
 * tele sin esperar al modelo. Cualquier otro chat, un comando con audio adjunto, el
 * modo apagado o un equipo sin escritorio no suena nunca.
 */
export function routeInboundToAltavoz(
  inbound: AltavozInbound,
  deps: AltavozInboundDeps,
): AltavozInboundResult {
  const mode = altavozTarget(inbound, deps);
  if (!mode || !inbound.audioFileId) return 'skipped';
  // Varios audios enviados juntos (álbum) suenan todos, en orden: antes solo el primero,
  // y en modo megáfono los demás ni sonaban ni se transcribían.
  const notes = [
    { fileId: inbound.audioFileId, mimeType: inbound.audioMimeType },
    ...(inbound.albumAudios ?? []),
  ];
  for (const [i, note] of notes.entries()) {
    const mimeType = note.mimeType ?? 'audio/ogg';
    const queued = deps.player.enqueue(
      mode,
      async () => {
        const bytes = await deps.download(note.fileId).catch(() => null);
        return bytes ? { bytes, mimeType } : null;
      },
      (err) => {
        const why = err instanceof Error ? err.message : String(err);
        deps.reply(`🔇 No he podido soltarla en el altavoz: ${why}`);
      },
      deps.key,
      (text) => deps.reply(text),
    );
    if (queued) continue;
    if (i === 0) {
      deps.reply('Hay demasiadas notas en cola en el altavoz; esta no la suelto.');
      return 'full';
    }
    const left = notes.length - i;
    deps.reply(
      `Hay demasiadas notas en cola en el altavoz; ${left === 1 ? 'la última no la suelto' : `las ${left} últimas no las suelto`}.`,
    );
    break;
  }
  return 'queued';
}

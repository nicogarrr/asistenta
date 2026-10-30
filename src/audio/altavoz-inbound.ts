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
 * Con PA_ALTAVOZ_VOZ=1, la respuesta a una nota que sonó en el altavoz se dice en el
 * mismo sitio (PC o tele), detrás de la nota en la cola. Se llama DESPUÉS de mandar el
 * texto y no espera a nada: la voz nunca retrasa la respuesta escrita. Un fallo de la
 * voz no avisa en el chat (el texto ya llegó); solo el aviso del firewall de la tele.
 */
export function routeReplyToAltavoz(
  inbound: AltavozInbound,
  replyText: string,
  deps: AltavozReplyDeps,
): AltavozInboundResult {
  if (!deps.enabled || !replyText.trim()) return 'skipped';
  const mode = altavozTarget(inbound, deps);
  if (!mode) return 'skipped';
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
  const fileId = inbound.audioFileId;
  const mimeType = inbound.audioMimeType ?? 'audio/ogg';
  const queued = deps.player.enqueue(
    mode,
    async () => {
      const bytes = await deps.download(fileId).catch(() => null);
      return bytes ? { bytes, mimeType } : null;
    },
    (err) => {
      const why = err instanceof Error ? err.message : String(err);
      deps.reply(`🔇 No he podido soltarla en el altavoz: ${why}`);
    },
    deps.key,
    (text) => deps.reply(text),
  );
  if (!queued) {
    deps.reply('Hay demasiadas notas en cola en el altavoz; esta no la suelto.');
    return 'full';
  }
  return 'queued';
}

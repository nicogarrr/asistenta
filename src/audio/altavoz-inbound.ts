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
 * Altavoz: una nota de voz del dueño, en su chat privado, suena sola en el PC o la
 * tele sin esperar al modelo. Cualquier otro chat, un comando con audio adjunto, el
 * modo apagado o un equipo sin escritorio no suena nunca.
 */
export function routeInboundToAltavoz(
  inbound: AltavozInbound,
  deps: AltavozInboundDeps,
): AltavozInboundResult {
  if (!inbound.audioFileId || inbound.text.trim().startsWith('/')) return 'skipped';
  const { mode } = deps;
  if (mode === 'off' || !deps.desktop || !isOwnerDm(inbound, deps.ownerUserId)) return 'skipped';
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

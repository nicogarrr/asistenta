import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import { type DownloadOptions, downloadFromLink } from '../media/download.js';
import { urlHostname } from '../text.js';

/**
 * "Descárgame este vídeo" / "pásame este PDF", with a link.
 *
 * The user pastes a YouTube, X, TikTok... link (or a PDF link) and gets the file back in
 * the chat. The model only supplies the URL; sizes, redirects and private addresses are
 * policed in code (src/media/download.ts), not by the prompt.
 */
export interface DownloadToolDeps {
  sendVideo: (bytes: Buffer, seconds: number, label: string) => Promise<boolean>;
  sendDocument: (bytes: Buffer, filename: string, caption: string) => Promise<boolean>;
  progress?: (what: 'upload_video' | 'upload_document') => Promise<void>;
  /** Anti-bot helpers from config (browser cookies for yt-dlp, curl-impersonate path). */
  options?: DownloadOptions;
  /**
   * Called once per attempt with the outcome. Only the host is passed on, never the
   * full URL: links often carry session tokens, and a log is the wrong place for them.
   */
  onResult?: (r: {
    ok: boolean;
    kind?: 'video' | 'pdf' | 'audio';
    host: string;
    reason?: string;
  }) => void;
}

const Params = Type.Object({
  url: Type.String({ description: 'Absolute http(s) link the user sent.' }),
  kind: Type.Optional(
    Type.Union(
      [Type.Literal('auto'), Type.Literal('video'), Type.Literal('pdf'), Type.Literal('audio')],
      {
        description:
          'auto (default): a .pdf link is a PDF, anything else a video. ' +
          'audio: keep only the sound as MP3 (music, podcasts, SoundCloud, the audio of a video).',
      },
    ),
  ),
});

/** Host para logs y avisos: el mismo host comparable que el navegador y las vigilancias. */
export function hostOf(url: string): string {
  return urlHostname(url) ?? 'enlace no válido';
}

/**
 * Why Telegram refused the file, in words the owner can act on. The raw error
 * («413: Request Entity Too Large», «http transport error: fetch failed») goes
 * only to the log: the model repeats this text in the chat.
 */
export function sendFailureText(raw: string): string {
  if (/\b413\b|too large|too big/i.test(raw)) {
    return 'el archivo pesa demasiado para enviarlo por Telegram (máximo 50 MB)';
  }
  if (/\b429\b|too many requests|retry after/i.test(raw)) {
    return 'Telegram pide esperar un poco; prueba otra vez en un minuto';
  }
  return 'no hubo respuesta de Telegram; prueba otra vez en un rato';
}

function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

export function createDownloadTool(deps: DownloadToolDeps): AgentTool<typeof Params> {
  return {
    name: 'download',
    label: 'Descargar vídeo o PDF',
    description: [
      'Download a video (YouTube, X/Twitter, TikTok, Instagram, Vimeo and most video sites)',
      'or a PDF from a link the user sent, and send the file to the chat as MP4 / document.',
      'With kind=audio it extracts only the sound and sends an MP3 ("quédate con el audio",',
      '"pásame la canción", podcasts, SoundCloud).',
      'Use it for "descarga este vídeo", "pásame este PDF", or a bare video link with that',
      'intent. The file is sent by this tool itself: do not describe it as sent unless the',
      'result says it was. Limit: 50 MB (Telegram). Private or login-only content fails; say',
      'so plainly, in Spanish, and never claim a download happened when the result is an error.',
    ].join(' '),
    parameters: Params,
    execute: async (_id, params) => {
      const kind = params.kind ?? 'auto';
      const result = await downloadFromLink(params.url, kind, deps.options);
      if (!result.ok) {
        log.warn('download failed', { host: hostOf(params.url), reason: result.reason });
        deps.onResult?.({ ok: false, host: hostOf(params.url), reason: result.reason });
        return ok(`No se pudo descargar: ${result.reason}.`, { ok: false });
      }
      const mb = (result.bytes.length / 1024 / 1024).toFixed(1);
      try {
        if (result.kind === 'video') {
          await deps.progress?.('upload_video').catch(() => undefined);
          await deps.sendVideo(result.bytes, result.seconds, result.title);
        } else {
          // PDF and audio both travel as documents: the MP3 keeps its <title>.mp3 name.
          await deps.progress?.('upload_document').catch(() => undefined);
          await deps.sendDocument(result.bytes, result.filename, result.title);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('download send failed', { host: hostOf(params.url), error: msg.slice(0, 120) });
        deps.onResult?.({
          ok: false,
          kind: result.kind,
          host: hostOf(params.url),
          reason: 'Telegram no aceptó el envío',
        });
        return ok(
          `Descargado (${mb} MB) pero Telegram no aceptó el envío: ${sendFailureText(msg)}.`,
          {
            ok: false,
          },
        );
      }
      deps.onResult?.({ ok: true, kind: result.kind, host: hostOf(params.url) });
      const what =
        result.kind === 'video' ? 'el vídeo' : result.kind === 'pdf' ? 'el PDF' : 'el audio';
      return ok(`Enviado ${what} "${result.title}" (${mb} MB).`, {
        ok: true,
        kind: result.kind,
        bytes: result.bytes.length,
      });
    },
  };
}

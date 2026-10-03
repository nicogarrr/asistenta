import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import { type DownloadOptions, downloadFromLink } from '../media/download.js';

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
}

const Params = Type.Object({
  url: Type.String({ description: 'Absolute http(s) link the user sent.' }),
  kind: Type.Optional(
    Type.Union([Type.Literal('auto'), Type.Literal('video'), Type.Literal('pdf')], {
      description: 'auto (default): a .pdf link is a PDF, anything else a video.',
    }),
  ),
});

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
        log.warn('download failed', { url: params.url, reason: result.reason });
        return ok(`No se pudo descargar: ${result.reason}.`, { ok: false });
      }
      const mb = (result.bytes.length / 1024 / 1024).toFixed(1);
      try {
        if (result.kind === 'video') {
          await deps.progress?.('upload_video').catch(() => undefined);
          await deps.sendVideo(result.bytes, result.seconds, result.title);
        } else {
          await deps.progress?.('upload_document').catch(() => undefined);
          await deps.sendDocument(result.bytes, result.filename, result.title);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('download send failed', { url: params.url, error: msg });
        return ok(`Descargado (${mb} MB) pero Telegram no aceptó el envío: ${msg}.`, { ok: false });
      }
      return ok(
        `Enviado ${result.kind === 'video' ? 'el vídeo' : 'el PDF'} "${result.title}" (${mb} MB).`,
        { ok: true, kind: result.kind, bytes: result.bytes.length },
      );
    },
  };
}

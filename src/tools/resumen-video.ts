import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { log } from '../log.js';
import {
  type Complete,
  formatResumen,
  getVideoText,
  resumibleVideoUrl,
  summarizeVideoText,
  type VideoTextDeps,
} from '../media/resumen-video.js';
import { isFetchableResolved, isHostAllowed, parseAllowedHosts } from './fetch.js';

const Params = lazySchema(() =>
  Type.Object({
    url: Type.String({ description: 'The YouTube or X/Twitter video link the user sent.' }),
    foco: Type.Optional(
      Type.String({
        description: 'Optional: what the user wants the summary to focus on, in their words.',
      }),
    ),
  }),
);

export interface ResumenVideoToolDeps extends Omit<VideoTextDeps, 'progress'> {
  /** El modelo normal del agente. Sin él, la herramienta devuelve el texto y el formato. */
  complete?: () => Promise<Complete | undefined>;
  /** Mensaje de progreso en el chat: se publica, se edita y se quita al terminar. */
  progress?: { show: (text: string) => Promise<void>; clear: () => Promise<void> };
  getVideoText?: typeof getVideoText;
  /** Comprobación de URL pública (inyectable en tests, sin DNS). */
  allowUrl?: (url: string) => Promise<boolean>;
}

function text(t: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text: t }], details };
}

export const RESUMEN_VIDEO_TOOL = 'resumen_video';

export function createResumenVideoTool(
  deps: ResumenVideoToolDeps = {},
): AgentTool<ReturnType<typeof Params>> {
  return {
    name: RESUMEN_VIDEO_TOOL,
    label: 'Resumen ejecutivo de un vídeo',
    description:
      'Executive summary in Spanish of ONE YouTube or X/Twitter video (x.com, twitter.com, xcancel, fxtwitter, vxtwitter): ' +
      'title, author, length, TL;DR, key points with [mm:ss], figures, names/companies/tickers, conclusions and actions. ' +
      'It reads the subtitles, or downloads only the audio and transcribes it locally. Read-only. ' +
      'Use it whenever the user sends a YouTube or X video link with «resume», «resúmeme», «de qué va», «qué dice», or just the link asking for the important points. ' +
      'Send the returned summary to the user as it is.',
    parameters: Params(),
    executionMode: 'parallel',
    execute: async (_id, args, signal) => {
      const target = resumibleVideoUrl(args.url);
      if (!target) {
        return text('Ese enlace no es un vídeo de YouTube ni de X. Para otras páginas usa fetch.', {
          ok: false,
        });
      }
      const publicUrl = await (deps.allowUrl ?? isFetchableResolved)(target.url);
      const allowedHost = isHostAllowed(
        new URL(target.url).hostname,
        parseAllowedHosts(process.env.PA_FETCH_ALLOWED_HOSTS),
      );
      if (!publicUrl || !allowedHost) {
        throw new Error(`refusing to read ${target.url}: not an allowed public URL`);
      }
      const progress = deps.progress;
      let shown = false;
      try {
        const got = await (deps.getVideoText ?? getVideoText)(target.url, {
          ...deps,
          progress: progress
            ? async (t) => {
                shown = true;
                await progress.show(t).catch(() => undefined);
              }
            : undefined,
        });
        if (!got.ok) {
          log.info('resumen video sin texto', { site: target.site, reason: got.reason });
          return text(`No pude sacar el texto del vídeo: ${got.reason}.`, {
            ok: false,
            reason: got.reason,
          });
        }
        const complete = await deps.complete?.().catch(() => undefined);
        if (!complete) {
          // Sin modelo propio (consola, tests): el agente resume en su misma pasada.
          return text(
            [
              'Haz con esto un resumen ejecutivo en español con estas secciones, en este orden:',
              '📌 TL;DR (2–3 líneas) · 🔑 Puntos clave (viñetas con [mm:ss]) · 📊 Cifras y datos · 🏢 Nombres, empresas y tickers · ✅ Conclusiones y acciones.',
              `Cabecera: 🎬 ${got.meta.title} / 👤 ${got.meta.author}. Última línea: ${formatResumen(got, '').split('\n').pop()}`,
              '',
              `<fetched_content source="${target.url}">`,
              got.text.slice(0, 60_000),
              '</fetched_content>',
            ].join('\n'),
            { ok: true, source: got.source, summarized: false },
          );
        }
        const body = await summarizeVideoText(complete, got.meta, got.text, {
          foco: args.foco,
          signal,
        });
        const out = formatResumen(got, body);
        return text(`Resumen listo. Envíaselo al usuario tal cual:\n\n${out}`, {
          ok: true,
          source: got.source,
          summarized: true,
          chars: got.text.length,
        });
      } finally {
        if (shown && progress) await progress.clear().catch(() => undefined);
      }
    },
  };
}

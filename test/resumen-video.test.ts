import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  formatResumen,
  getVideoText,
  isXVideoUrl,
  looksLikeTranscriptLoop,
  parseMeta,
  RESUMEN_SECTIONS,
  SINGLE_PASS_CHARS,
  summarizeVideoText,
  vttToTimedText,
  xVideoUrl,
} from '../src/media/resumen-video.js';
import type { Runner } from '../src/media/transcript.js';
import { createResumenVideoTool } from '../src/tools/resumen-video.js';

describe('resumen_video: enlaces de X', () => {
  it('reconoce x.com, twitter.com, xcancel, fxtwitter y vxtwitter y los normaliza', () => {
    for (const u of [
      'https://x.com/elonmusk/status/1850000000000000000',
      'https://twitter.com/elonmusk/status/1850000000000000000?s=20',
      'https://mobile.twitter.com/elonmusk/status/1850000000000000000',
      'https://xcancel.com/elonmusk/status/1850000000000000000',
      'https://fxtwitter.com/elonmusk/status/1850000000000000000',
      'https://vxtwitter.com/elonmusk/status/1850000000000000000/video/1',
      'https://www.x.com/elonmusk/status/1850000000000000000',
    ]) {
      expect(xVideoUrl(u), u).toBe('https://x.com/elonmusk/status/1850000000000000000');
    }
  });
  it('no confunde perfiles, búsquedas ni otros sitios', () => {
    for (const u of [
      'https://x.com/elonmusk',
      'https://x.com/search?q=hola',
      'https://notx.com/a/status/1850000000000000000',
      'https://x.com.evil.example/a/status/1850000000000000000',
      'ftp://x.com/a/status/1850000000000000000',
      'no es un enlace',
    ]) {
      expect(isXVideoUrl(u), u).toBe(false);
    }
  });
});

/** yt-dlp y ffmpeg de mentira: escriben lo que escribirían los de verdad. */
function fakeRunner(opts: {
  durationSec: number;
  subs?: string;
  loginFirst?: boolean;
  metaLine?: string;
}) {
  const calls: { file: string; args: string[] }[] = [];
  let probes = 0;
  const runner: Runner = async (file, args) => {
    calls.push({ file, args });
    const out = args[args.indexOf('-o') + 1] ?? args[args.length - 1] ?? '';
    if (file === 'ffmpeg') {
      const target = args[args.length - 1] as string;
      await writeFile(target, Buffer.alloc(64_000, 1));
      return { stdout: '', stderr: '', code: 0 };
    }
    if (args.includes('--skip-download')) {
      probes++;
      if (opts.loginFirst && probes === 1 && !args.includes('--cookies-from-browser')) {
        return { stdout: '', stderr: 'ERROR: This post requires login (NSFW)', code: 1 };
      }
      if (opts.subs) {
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out.replace('%(ext)s', 'es.vtt'), opts.subs);
      }
      return {
        stdout: `${opts.metaLine ?? `Título del vídeo\tCanal X\t${opts.durationSec}`}\n`,
        stderr: '',
        code: 0,
      };
    }
    await writeFile(out.replace('%(ext)s', 'm4a'), 'audio');
    return { stdout: '', stderr: '', code: 0 };
  };
  return { runner, calls };
}

describe('resumen_video: texto del vídeo', () => {
  it('YouTube con subtítulos: los usa con minuto y no baja el audio', async () => {
    const vtt =
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHola a todos\n\n00:01:05.000 --> 00:01:07.000\nLas ventas subieron un 20 %\n';
    const { runner, calls } = fakeRunner({ durationSec: 600, subs: vtt });
    const r = await getVideoText('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      transcribe: async () => 'no debería',
    });
    expect(r.ok && r.source).toBe('subtitulos');
    expect(r.ok && r.text).toContain('[01:05] Las ventas subieron un 20 %');
    expect(calls.some((c) => c.args.includes('bestaudio/best'))).toBe(false);
  });

  it('X: baja solo el audio, lo trocea y lo transcribe con whisper; avisa del progreso', async () => {
    const { runner, calls } = fakeRunner({ durationSec: 12 * 60 });
    const progress: string[] = [];
    let n = 0;
    const r = await getVideoText('https://twitter.com/user/status/1850000000000000000', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      env: {},
      transcribe: async (_b, mime) => {
        expect(mime).toBe('audio/wav');
        return `trozo ${++n}`;
      },
      progress: (t) => {
        progress.push(t);
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe('audio');
    expect(r.meta).toEqual({
      title: 'Título del vídeo',
      author: 'Canal X (@user)',
      durationSeconds: 720,
    });
    const dl = calls.find((c) => c.args.includes('bestaudio/best'));
    expect(dl?.args).toContain('https://x.com/user/status/1850000000000000000');
    expect(dl?.args).not.toContain('bestvideo');
    // 12 min en trozos de 2 (por defecto): 6 trozos.
    expect(calls.filter((c) => c.file === 'ffmpeg')).toHaveLength(6);
    expect(r.text.split('\n')[0]).toBe('[00:00] trozo 1');
    expect(r.text.split('\n')[5]).toBe('[10:00] trozo 6');
    expect(progress[0]).toBe('🎧 Transcribiendo 12 min…');
  });

  it('X sin autor en los metadatos: usa la cuenta del enlace, no la categoría', async () => {
    const { runner } = fakeRunner({ durationSec: 60, metaLine: 'T\tNA\t60\tTech' });
    const r = await getVideoText('https://x.com/jonfortt/status/2112533633500086754', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      transcribe: async () => 'hola',
    });
    expect(r.ok && r.meta.author).toBe('@jonfortt');
    expect(parseMeta('T\tNA\t60\tCanal\n').author).toBe('Canal');
  });

  it('X que pide sesión: reintenta con las cookies del navegador configurado', async () => {
    const { runner, calls } = fakeRunner({ durationSec: 60, loginFirst: true });
    const r = await getVideoText('https://x.com/u/status/1850000000000000000', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      cookiesFromBrowser: 'firefox',
      transcribe: async () => 'hola',
    });
    expect(r.ok).toBe(true);
    const dl = calls.find((c) => c.args.includes('bestaudio/best'));
    expect(dl?.args.join(' ')).toContain('--cookies-from-browser firefox');
  });

  it('tope de duración: un vídeo de 3 h solo transcribe PA_RESUMEN_MAX_MIN y lo dice', async () => {
    const { runner, calls } = fakeRunner({ durationSec: 3 * 3600 });
    const r = await getVideoText('https://x.com/u/status/1850000000000000000', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      env: { PA_RESUMEN_MAX_MIN: '20', PA_RESUMEN_CHUNK_MIN: '10' },
      transcribe: async () => 'texto',
    });
    expect(calls.filter((c) => c.file === 'ffmpeg')).toHaveLength(2);
    const last = calls.filter((c) => c.file === 'ffmpeg').at(-1)?.args ?? [];
    expect(last[last.indexOf('-ss') + 1]).toBe('600');
    expect(r.ok && r.cappedAtMin).toBe(20);
    if (r.ok) expect(formatResumen(r, 'x')).toContain('solo los primeros 20 min');
  });

  it('los bucles de whisper sobre ruido («I I I I…») no cuentan como texto', async () => {
    expect(looksLikeTranscriptLoop(`${'I '.repeat(200)}`)).toBe(true);
    expect(looksLikeTranscriptLoop('gracias. '.repeat(30))).toBe(true);
    expect(
      looksLikeTranscriptLoop('Hoy NVIDIA presenta resultados y sube un 5 % antes de abrir.'),
    ).toBe(false);
    const { runner } = fakeRunner({ durationSec: 60 });
    const r = await getVideoText('https://x.com/u/status/1850000000000000000', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      transcribe: async () => 'I '.repeat(300),
    });
    expect(r).toEqual({ ok: false, reason: 'el audio no tiene voz que transcribir' });
  });

  it('un trozo que whisper no puede leer se reintenta en piezas de 30 s', async () => {
    const { runner, calls } = fakeRunner({ durationSec: 60 });
    let n = 0;
    const r = await getVideoText('https://x.com/u/status/1850000000000000000', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      env: {},
      transcribe: async () => {
        n++;
        if (n === 1) throw new Error('token_ids must be a non-empty array of integers.');
        if (n === 2) throw new Error('token_ids must be a non-empty array of integers.');
        return 'segunda mitad';
      },
    });
    expect(r.ok && r.text).toBe('[00:30] segunda mitad');
    const cuts = calls
      .filter((c) => c.file === 'ffmpeg')
      .map((c) => c.args[c.args.indexOf('-ss') + 1]);
    expect(cuts).toEqual(['0', '0', '30']);
  });

  it('por defecto el tope es 90 min', async () => {
    const { runner, calls } = fakeRunner({ durationSec: 4 * 3600 });
    await getVideoText('https://x.com/u/status/1850000000000000000', {
      runImpl: runner,
      ytdlp: 'yt-dlp',
      ffmpeg: 'ffmpeg',
      env: {},
      transcribe: async () => 'texto',
    });
    expect(calls.filter((c) => c.file === 'ffmpeg')).toHaveLength(45);
  });
});

describe('resumen_video: formato', () => {
  const v = {
    ok: true as const,
    meta: { title: 'Resultados Q3', author: 'Inversor', durationSeconds: 3725 },
    text: '',
    source: 'subtitulos' as const,
    lang: 'es',
  };
  it('cabecera, todas las secciones en orden y la línea de origen', () => {
    const out = formatResumen(v, '📌 TL;DR\nTodo sube.\n\n🔑 Puntos clave\n• [01:05] Ventas +20 %');
    expect(out.split('\n')[0]).toBe('🎬 Resultados Q3');
    expect(out).toContain('👤 Inversor · ⏱️ 1:02:05');
    let at = -1;
    for (const s of RESUMEN_SECTIONS) {
      const i = out.indexOf(s);
      expect(i, s).toBeGreaterThan(at);
      at = i;
    }
    expect(out).toContain('📊 Cifras y datos\n• No se mencionan.');
    expect(out.trim().split('\n').at(-1)).toBe('ℹ️ Sacado de los subtítulos de YouTube (es).');
    expect(
      formatResumen({ ...v, source: 'audio' }, 'x')
        .trim()
        .split('\n')
        .at(-1),
    ).toContain('transcribiendo el audio');
  });

  it('una pasada si el texto es corto; por trozos (map-reduce) si es largo', async () => {
    const complete = vi.fn(async (_s: string, _u: string, _o: { maxTokens: number }) => 'notas');
    await summarizeVideoText(complete, v.meta, 'corto');
    expect(complete).toHaveBeenCalledTimes(1);
    complete.mockClear();
    const largo = Array.from({ length: 4000 }, (_, i) => `[00:${i}] frase ${'x'.repeat(40)}`).join(
      '\n',
    );
    expect(largo.length).toBeGreaterThan(SINGLE_PASS_CHARS);
    await summarizeVideoText(complete, v.meta, largo);
    expect(complete.mock.calls.length).toBeGreaterThan(2);
    const finalUser = complete.mock.calls.at(-1)?.[1] as string;
    expect(finalUser).toContain('— Trozo 1');
  });

  it('vttToTimedText agrupa por bloques con minuto y quita repetidos', () => {
    const vtt =
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<c>hola</c>\n\n00:00:02.000 --> 00:00:04.000\nhola\n\n00:00:40.000 --> 00:00:42.000\nadiós';
    expect(vttToTimedText(vtt)).toBe('[00:00] hola\n[00:40] adiós');
  });
});

describe('herramienta resumen_video', () => {
  it('resume con el modelo, enseña el progreso y lo quita al acabar', async () => {
    const events: string[] = [];
    const tool = createResumenVideoTool({
      allowUrl: async () => true,
      getVideoText: async (_u, d) => {
        await d?.progress?.('🎧 Transcribiendo 3 min…');
        return {
          ok: true,
          meta: { title: 'T', author: 'A', durationSeconds: 180 },
          text: '[00:00] hola',
          source: 'audio',
        };
      },
      complete: async () => async () => '📌 TL;DR\nResumen.',
      progress: {
        show: async (t) => {
          events.push(`show ${t}`);
        },
        clear: async () => {
          events.push('clear');
        },
      },
    });
    const r = await tool.execute('1', { url: 'https://x.com/u/status/1850000000000000000' });
    const out = (r.content[0] as { text: string }).text;
    expect(out).toContain('🎬 T');
    expect(out).toContain('🔑 Puntos clave');
    expect(events).toEqual(['show 🎧 Transcribiendo 3 min…', 'clear']);
  });

  it('un enlace que no es de vídeo no hace nada', async () => {
    const get = vi.fn();
    const tool = createResumenVideoTool({ getVideoText: get });
    const r = await tool.execute('1', { url: 'https://example.com/a' });
    expect((r.content[0] as { text: string }).text).toContain('no es un vídeo');
    expect(get).not.toHaveBeenCalled();
  });
});

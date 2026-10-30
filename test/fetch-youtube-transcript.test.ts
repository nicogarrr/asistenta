import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '142.250.184.14', family: 4 }]),
}));

import {
  fetchYoutubeTranscript,
  isYoutubeVideoUrl,
  type Runner,
  vttToText,
} from '../src/media/transcript.js';
import { createFetchTool } from '../src/tools/fetch.js';

const VTT_ES = `WEBVTT
Kind: captions
Language: es

00:00:00.000 --> 00:00:02.000
<c>Hola</c> a todos

00:00:01.500 --> 00:00:03.000
Hola a todos
hoy hablamos de NAS

00:00:03.000 --> 00:00:05.000
hoy hablamos de NAS
`;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PA_FETCH_ALLOWED_HOSTS;
});

describe('enlace de vídeo de YouTube', () => {
  it('reconoce vídeos y no canales ni otras webs', () => {
    expect(isYoutubeVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isYoutubeVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=3')).toBe(true);
    expect(isYoutubeVideoUrl('https://m.youtube.com/shorts/abcdefghijk')).toBe(true);
    expect(isYoutubeVideoUrl('https://www.youtube.com/@canal')).toBe(false);
    expect(isYoutubeVideoUrl('https://www.youtube.com/watch')).toBe(false);
    expect(isYoutubeVideoUrl('https://notyoutube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isYoutubeVideoUrl('file:///youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
  });

  it('los subtítulos quedan en texto sin tiempos ni repeticiones', () => {
    expect(vttToText(VTT_ES)).toBe('Hola a todos\nhoy hablamos de NAS');
  });
});

describe('fetchYoutubeTranscript (yt-dlp falso)', () => {
  it('pide solo subtítulos y prefiere español', async () => {
    let seen: string[] = [];
    const runImpl: Runner = async (_file, args) => {
      seen = args;
      const out = args[args.indexOf('-o') + 1] ?? '';
      writeFileSync(out.replace('%(ext)s', 'en.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n');
      writeFileSync(out.replace('%(ext)s', 'es.vtt'), VTT_ES);
      return { stdout: 'Mi vídeo\n', stderr: '', code: 0 };
    };
    const r = await fetchYoutubeTranscript('https://youtu.be/dQw4w9WgXcQ', { runImpl });
    expect(r).toEqual({
      ok: true,
      title: 'Mi vídeo',
      lang: 'es',
      text: 'Hola a todos\nhoy hablamos de NAS',
    });
    expect(seen).toContain('--skip-download');
    expect(seen).not.toContain('-x');
  });

  it('sin subtítulos lo dice', async () => {
    const runImpl: Runner = async () => ({ stdout: 'X\n', stderr: '', code: 0 });
    const r = await fetchYoutubeTranscript('https://youtu.be/dQw4w9WgXcQ', { runImpl });
    expect(r).toEqual({ ok: false, reason: 'el vídeo no tiene subtítulos' });
  });
});

describe('herramienta fetch con un enlace de YouTube', () => {
  const call = (tool: ReturnType<typeof createFetchTool>, url: string) =>
    tool.execute('t1', { url } as never) as Promise<{
      content: { text: string }[];
      details: Record<string, unknown>;
    }>;

  it('devuelve la transcripción en vez del HTML', async () => {
    const page = vi.fn();
    vi.stubGlobal('fetch', page);
    const tool = createFetchTool(20_000, {
      transcript: async () => ({ ok: true, title: 'Charla', lang: 'es', text: 'hola mundo' }),
    });
    const r = await call(tool, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(r.content[0]?.text).toContain('Transcript of the YouTube video "Charla"');
    expect(r.content[0]?.text).toContain('<fetched_content source=');
    expect(r.content[0]?.text).toContain('hola mundo');
    expect(r.details.transcript).toBe(true);
    expect(page).not.toHaveBeenCalled();
  });

  it('si no hay subtítulos lee la página como siempre', async () => {
    const page = vi.fn(
      async () =>
        new Response('<html><body><p>pagina del video</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    vi.stubGlobal('fetch', page);
    const tool = createFetchTool(20_000, {
      transcript: async () => ({ ok: false, reason: 'el vídeo no tiene subtítulos' }),
    });
    const r = await call(tool, 'https://youtu.be/dQw4w9WgXcQ');
    expect(page).toHaveBeenCalled();
    expect(r.content[0]?.text).toContain('pagina del video');
  });

  it('respeta PA_FETCH_ALLOWED_HOSTS: sin YouTube en la lista no lee subtítulos', async () => {
    process.env.PA_FETCH_ALLOWED_HOSTS = 'example.com';
    const transcript = vi.fn();
    vi.stubGlobal('fetch', vi.fn());
    const tool = createFetchTool(20_000, { transcript });
    await expect(call(tool, 'https://youtu.be/dQw4w9WgXcQ')).rejects.toThrow();
    expect(transcript).not.toHaveBeenCalled();
  });

  it('otras webs no pasan por los subtítulos', async () => {
    const transcript = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('hola', { status: 200, headers: { 'content-type': 'text/plain' } }),
      ),
    );
    const tool = createFetchTool(20_000, { transcript });
    await call(tool, 'https://example.com/a');
    expect(transcript).not.toHaveBeenCalled();
  });
});

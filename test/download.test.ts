import { describe, expect, it } from 'vitest';
import {
  downloadPdf,
  explainHttpStatus,
  explainNonPdfBody,
  explainYtdlpError,
  parsePublicUrl,
} from '../src/media/download.js';

const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');

function resp(body: Buffer | string, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    status: 200,
    ...init,
  });
}

describe('parsePublicUrl', () => {
  it('accepts public http(s) and rejects local, private and other schemes', () => {
    expect(parsePublicUrl('https://youtu.be/abc')).not.toBeNull();
    expect(parsePublicUrl('http://localhost:3000/a.pdf')).toBeNull();
    expect(parsePublicUrl('http://192.168.1.5/a.pdf')).toBeNull();
    expect(parsePublicUrl('file:///etc/passwd')).toBeNull();
    expect(parsePublicUrl('no es un enlace')).toBeNull();
  });
});

describe('explainYtdlpError', () => {
  it('maps common failures to Spanish reasons', () => {
    expect(explainYtdlpError('ERROR: Unsupported URL: https://x')).toMatch(/ningún vídeo/);
    expect(explainYtdlpError('ERROR: Private video. Sign in')).toMatch(/privado/);
    expect(explainYtdlpError('ERROR: Video unavailable')).toMatch(/no está disponible/);
    expect(explainYtdlpError('boom')).toMatch(/yt-dlp no pudo/);
  });
});

describe('downloadPdf', () => {
  it('returns the bytes and a filename for a real PDF', async () => {
    const r = await downloadPdf('https://example.org/files/informe', async () =>
      resp(pdfBytes, {
        headers: { 'content-disposition': 'attachment; filename="Informe 2026.pdf"' },
      }),
    );
    expect(r.ok && r.filename).toBe('Informe 2026.pdf');
    expect(r.ok && r.bytes.equals(pdfBytes)).toBe(true);
  });

  it('returns a valid PDF even when the URL filename has malformed percent escapes', async () => {
    const r = await downloadPdf('https://example.org/informe%ZZ.pdf', async () => resp(pdfBytes));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.filename).toBe('informe%ZZ.pdf');
      expect(r.bytes.equals(pdfBytes)).toBe(true);
    }
  });

  it('refuses an HTML page served under a pdf name', async () => {
    const r = await downloadPdf('https://example.org/a.pdf', async () =>
      resp('<html>login</html>'),
    );
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(/no devuelve un PDF/);
  });

  it('refuses a redirect to a private address', async () => {
    const r = await downloadPdf('https://example.org/a.pdf', async () =>
      resp('', { status: 302, headers: { location: 'http://127.0.0.1/secret.pdf' } }),
    );
    expect(!r.ok && r.reason).toMatch(/no permitida/);
  });

  it('refuses a declared size over the Telegram cap', async () => {
    const r = await downloadPdf('https://example.org/a.pdf', async () =>
      resp(pdfBytes, { headers: { 'content-length': String(60 * 1024 * 1024) } }),
    );
    expect(!r.ok && r.reason).toMatch(/50 MB/);
  });
});

describe('downloadFromLink', () => {
  it('a .pdf link that fails reports the PDF reason, not a video one', async () => {
    const { downloadFromLink } = await import('../src/media/download.js');
    const r = await downloadFromLink('http://localhost/a.pdf');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toMatch(/vídeo/);
  });
});

describe('explainYtdlpError', () => {
  it('does not read "rate" inside other words as rate limiting', () => {
    expect(explainYtdlpError('ERROR: moderate quality generated')).not.toMatch(/limitado/);
  });

  it('a country block is not misread as a removed video', () => {
    // The loose "not available" phrase must not win over the geo reason.
    expect(
      explainYtdlpError('ERROR: [youtube] abc123: This video is not available in your country'),
    ).toMatch(/bloqueado en tu país/);
    expect(
      explainYtdlpError(
        'ERROR: Video unavailable. The uploader has not made this video available in your country.',
      ),
    ).toMatch(/bloqueado en tu país/);
  });

  it('a plain removal still says not available', () => {
    expect(explainYtdlpError('ERROR: [youtube] abc123: Video unavailable')).toMatch(
      /no está disponible/,
    );
    expect(explainYtdlpError('ERROR: HTTP Error 404: Not Found')).toMatch(/no está disponible/);
  });

  it('an HTTP 403 reports denial without claiming its cause, with the next step', () => {
    expect(
      explainYtdlpError('ERROR: unable to download video data: HTTP Error 403: Forbidden'),
    ).toMatch(/anti-bot/);
    // With cookies already configured, asking for them again would be useless advice.
    const withCookies = explainYtdlpError('ERROR: HTTP Error 403: Forbidden', {
      cookies: 'firefox',
    });
    expect(withCookies).toMatch(/firefox/);
    expect(withCookies).toContain('puede ser una protección anti-bot o un problema de sesión/permisos');
    expect(withCookies).not.toContain('; es una protección anti-bot');
    expect(withCookies).not.toMatch(/activa las cookies/);
  });
});

describe('mensajes de login, captcha y errores HTTP', () => {
  it('tells login from captcha from a plain page', () => {
    expect(explainNonPdfBody('<form><input type="password"></form>')).toMatch(/inicio de sesión/);
    expect(explainNonPdfBody('<title>Just a moment...</title>')).toMatch(/captcha/);
    expect(explainNonPdfBody('<h1>Hola</h1>')).toMatch(/página web/);
    for (const t of ['x', '<form><input type="password">', 'captcha'])
      expect(explainNonPdfBody(t)).toMatch(/no devuelve un PDF/);
  });

  it('explains HTTP statuses in Spanish', () => {
    expect(explainHttpStatus(401)).toMatch(/iniciar sesión/);
    expect(explainHttpStatus(404)).toMatch(/ya no existe/);
    expect(explainHttpStatus(429)).toMatch(/demasiadas peticiones/);
    expect(explainHttpStatus(502)).toMatch(/fallo/);
    expect(explainHttpStatus(418)).toBe('el sitio respondió con error 418');
  });

  it('downloadPdf surfaces the login page and a 401', async () => {
    const login = await downloadPdf(
      'https://example.org/a.pdf',
      async () => new Response('<html><input type="password"></html>', { status: 200 }),
    );
    expect(!login.ok && login.reason).toMatch(/inicio de sesión/);
    const denied = await downloadPdf(
      'https://example.org/b.pdf',
      async () => new Response('no', { status: 401 }),
    );
    expect(!denied.ok && denied.reason).toMatch(/exige iniciar sesión/);
  });
});

describe('createDownloadTool onResult', () => {
  it('reports only the host, never the full URL', async () => {
    const { createDownloadTool } = await import('../src/tools/download.js');
    const seen: { ok: boolean; host: string; reason?: string }[] = [];
    const tool = createDownloadTool({
      sendVideo: async () => true,
      sendDocument: async () => true,
      onResult: (r) => seen.push(r),
    });
    await tool.execute(
      't',
      { url: 'http://localhost/secret?token=abc' },
      undefined as never,
      undefined as never,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ ok: false, host: 'localhost' });
    expect(JSON.stringify(seen)).not.toContain('token=abc');
  });
});

describe('audioFilename', () => {
  it('keeps the title, strips unsafe characters and appends .mp3', async () => {
    const { audioFilename } = await import('../src/media/download.js');
    expect(audioFilename('La Canción (Directo)')).toBe('La Canción (Directo).mp3');
    expect(audioFilename('ya.mp3')).toBe('ya.mp3');
    expect(audioFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j.mp3');
    expect(audioFilename('   ')).toBe('audio.mp3');
    expect(audioFilename('x'.repeat(200)).length).toBeLessThanOrEqual(124);
  });
});

describe('downloadAudio', () => {
  // A public IP literal skips DNS, so these tests never touch the network.
  const URL = 'https://1.1.1.1/media/track';
  type RunResult = { stdout: string; stderr: string; code: number | 'ENOENT' };
  type RunFn = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;

  /** Fake yt-dlp: writes the "downloaded" mp3 into the temp dir the args point at. */
  const fakeRun =
    (mp3: Buffer, title = 'Mi Canción', seconds = '187'): RunFn =>
    async (_file, args) => {
      if (args[0] === '--list-impersonate-targets') return { stdout: '', stderr: '', code: 0 };
      const out = args[args.indexOf('-o') + 1];
      if (!out) throw new Error('args sin -o');
      const path = out.replace('%(ext)s', 'mp3');
      await import('node:fs/promises').then((fs) => fs.writeFile(path, mp3));
      return { stdout: `${path}\n${title}\n${seconds}\n`, stderr: '', code: 0 };
    };

  it('extracts the audio and returns title, seconds and a .mp3 filename', async () => {
    const { downloadAudio, resetDownloadCachesForTests } = await import('../src/media/download.js');
    resetDownloadCachesForTests();
    const bytes = Buffer.from('ID3-fake-mp3-bytes');
    const r = await downloadAudio(URL, 'yt-dlp-falso', {}, fakeRun(bytes));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('audio');
    expect(r.title).toBe('Mi Canción');
    expect(r.seconds).toBe(187);
    expect(r.filename).toBe('Mi Canción.mp3');
    expect(r.bytes.equals(bytes)).toBe(true);
  });

  it('asks yt-dlp for an mp3 extraction with ffmpeg and the 50 MB cap', async () => {
    const { downloadAudio, resetDownloadCachesForTests, MAX_UPLOAD_BYTES } = await import(
      '../src/media/download.js'
    );
    resetDownloadCachesForTests();
    let seen: string[] = [];
    const spy: RunFn = async (_file, args) => {
      if (args[0] === '--list-impersonate-targets') return { stdout: '', stderr: '', code: 0 };
      seen = args;
      const tmpl = args[args.indexOf('-o') + 1];
      if (!tmpl) throw new Error('args sin -o');
      const out = tmpl.replace('%(ext)s', 'mp3');
      await import('node:fs/promises').then((fs) => fs.writeFile(out, Buffer.from('x')));
      return { stdout: `${out}\nT\n1\n`, stderr: '', code: 0 };
    };
    await downloadAudio(URL, 'yt-dlp-falso', {}, spy);
    expect(seen).toContain('-x');
    expect(seen).toContain('mp3');
    expect(seen).toContain('--ffmpeg-location');
    expect(seen).toContain(String(MAX_UPLOAD_BYTES));
    expect(seen).toContain('--no-playlist');
  });

  it('reports a >50 MB result instead of sending it', async () => {
    const { downloadAudio, resetDownloadCachesForTests, MAX_UPLOAD_BYTES } = await import(
      '../src/media/download.js'
    );
    resetDownloadCachesForTests();
    const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0);
    const r = await downloadAudio(URL, 'yt-dlp-falso', {}, fakeRun(big));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/50 MB/);
  });

  it('says plainly when yt-dlp is not installed', async () => {
    const { downloadAudio, resetDownloadCachesForTests } = await import('../src/media/download.js');
    resetDownloadCachesForTests();
    const missing: RunFn = async () => ({ stdout: '', stderr: '', code: 'ENOENT' });
    const r = await downloadAudio(URL, 'yt-dlp-que-no-existe', {}, missing);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no tengo yt-dlp instalado/);
  });

  it('maps yt-dlp failures to an honest Spanish reason (audio wording)', async () => {
    const { downloadAudio, resetDownloadCachesForTests } = await import('../src/media/download.js');
    resetDownloadCachesForTests();
    const failing: RunFn = async (_file, args) =>
      args[0] === '--list-impersonate-targets'
        ? { stdout: '', stderr: '', code: 0 }
        : { stdout: '', stderr: 'ERROR: Unsupported URL: https://x', code: 1 };
    const r = await downloadAudio(URL, 'yt-dlp-falso', {}, failing);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/ningún vídeo ni audio/);
  });

  it('rejects private and non-http(s) links before running anything', async () => {
    const { downloadAudio } = await import('../src/media/download.js');
    const never: RunFn = async () => {
      throw new Error('yt-dlp must not run for a blocked URL');
    };
    const r = await downloadAudio('http://192.168.0.1/track.mp3', 'yt-dlp-falso', {}, never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/enlaces públicos/);
  });
});

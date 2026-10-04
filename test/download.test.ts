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

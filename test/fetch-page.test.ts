import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPage, MAX_FETCH_BYTES } from '../src/tools/fetch.js';

// Public IP literals: the SSRF gate judges them without DNS, so nothing leaves the box.
const PUBLIC = 'http://93.184.216.34';

function bytesResponse(bytes: Uint8Array, headers: Record<string, string>, status = 200) {
  return new Response(bytes.slice().buffer as ArrayBuffer, { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('fetchPage: redirecciones bajo el control SSRF', () => {
  it('sigue una redirección pública y devuelve el texto de la página final', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === `${PUBLIC}/a`
        ? new Response(null, { status: 302, headers: { location: '/b' } })
        : new Response('<html><body><h1>Hola</h1><p>mundo</p></body></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const page = await fetchPage(`${PUBLIC}/a`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${PUBLIC}/b`);
    expect(page.text).toContain('# Hola');
    expect(page.text).toContain('mundo');
    expect(page.truncated).toBe(false);
  });

  it('una redirección a la red interna se rechaza en el segundo salto, sin pedirla', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPage(`${PUBLIC}/x`)).rejects.toThrow(/not a public/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('una redirección fuera de PA_FETCH_ALLOWED_HOSTS se rechaza', async () => {
    vi.stubEnv('PA_FETCH_ALLOWED_HOSTS', '93.184.216.34');
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 301, headers: { location: 'http://1.1.1.1/' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPage(`${PUBLIC}/`)).rejects.toThrow(/PA_FETCH_ALLOWED_HOSTS/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('demasiadas redirecciones y redirección sin Location fallan en claro', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302, headers: { location: '/otra' } })),
    );
    await expect(fetchPage(`${PUBLIC}/`)).rejects.toThrow(/too many redirects/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302 })),
    );
    await expect(fetchPage(`${PUBLIC}/`)).rejects.toThrow(/without location/);
  });

  it('un 404 es un error, no una página vacía', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 404, statusText: 'Not Found' })),
    );
    await expect(fetchPage(`${PUBLIC}/`)).rejects.toThrow(/404/);
  });

  it('el tiempo agotado dice el tiempo real, no siempre 30 s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init.signal?.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      ),
    );
    await expect(fetchPage(`${PUBLIC}/`, { timeoutMs: 20 })).rejects.toThrow(
      /timed out after 0\.02s/,
    );
  });
});

describe('fetchPage: el texto se decodifica con el juego de caracteres de la página', () => {
  // Muchas webs españolas siguen sirviendo ISO-8859-1 / windows-1252; Response.text()
  // siempre decodifica como UTF-8 y convertía «España» y «€» en «Espa�a» y «�».
  const latin1 = Uint8Array.from([
    ...Buffer.from('<html><body><p>Env', 'latin1'),
    0xed, // í
    ...Buffer.from('o a Espa', 'latin1'),
    0xf1, // ñ
    ...Buffer.from('a: 12,50 ', 'latin1'),
    0x80, // € en windows-1252
    ...Buffer.from('</p></body></html>', 'latin1'),
  ]);

  it('respeta el charset de la cabecera Content-Type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bytesResponse(latin1, { 'content-type': 'text/html; charset=ISO-8859-1' })),
    );
    const page = await fetchPage(`${PUBLIC}/`, { format: 'text' });
    expect(page.text).toContain('Envío a España: 12,50 €');
    expect(page.text).not.toContain('\uFFFD');
  });

  it('respeta <meta charset> cuando la cabecera no lo dice', async () => {
    const head = Buffer.from('<html><head><meta charset="windows-1252"></head>', 'latin1');
    const body = Uint8Array.from([...head, ...latin1]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bytesResponse(body, { 'content-type': 'text/html' })),
    );
    const page = await fetchPage(`${PUBLIC}/`, { format: 'text' });
    expect(page.text).toContain('España: 12,50 €');
  });

  it('UTF-8 sigue siendo el valor por defecto', async () => {
    const utf8 = new TextEncoder().encode('<p>Envío a España: 12,50 €</p>');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bytesResponse(utf8, { 'content-type': 'text/html' })),
    );
    const page = await fetchPage(`${PUBLIC}/`, { format: 'text' });
    expect(page.text).toContain('Envío a España: 12,50 €');
  });

  it('un charset desconocido no rompe la descarga: cae a UTF-8', async () => {
    const utf8 = new TextEncoder().encode('hola ñ');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bytesResponse(utf8, { 'content-type': 'text/plain; charset=x-inventado' })),
    );
    const page = await fetchPage(`${PUBLIC}/`);
    expect(page.text).toBe('hola ñ');
  });
});

describe('fetchPage: una respuesta enorme no se lee entera en memoria', () => {
  it(`deja de leer al pasar MAX_FETCH_BYTES y marca la página como truncada`, async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61); // 1 MiB de "a"
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        if (pulled > 200 * 1024 * 1024) controller.close();
        else controller.enqueue(chunk);
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(endless, { headers: { 'content-type': 'text/plain' } })),
    );
    const page = await fetchPage(`${PUBLIC}/big`, { maxChars: 100 });
    expect(pulled).toBeLessThanOrEqual(MAX_FETCH_BYTES + 3 * chunk.byteLength);
    expect(page.truncated).toBe(true);
    expect(page.text.startsWith('a'.repeat(100))).toBe(true);
  });

  it('un cuerpo sin stream (dobles de test antiguos) se sigue leyendo con text()', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        ok: true,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/plain' }),
        body: null,
        text: async () => 'plano',
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    const page = await fetchPage(`${PUBLIC}/`);
    expect(page.text).toBe('plano');
  });
});

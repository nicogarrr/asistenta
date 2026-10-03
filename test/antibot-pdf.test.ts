import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import { curlImpersonateFetch, downloadPdf, findCurlImpersonate } from '../src/media/download.js';

const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const posix = process.platform !== 'win32';

function resp(body: Buffer | string, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    status: 200,
    ...init,
  });
}

describe('downloadPdf behind an anti-bot wall', () => {
  const blocked: typeof fetch = async () => resp('blocked', { status: 403 });
  const viaCurlOk: typeof fetch = async () => resp(pdfBytes);

  it('retries with curl-impersonate on a 403 and returns the PDF', async () => {
    const r = await downloadPdf('https://example.org/a.pdf', blocked, { curlFetch: viaCurlOk });
    expect(r.ok).toBe(true);
  });

  it('also treats 429, 503 and a cf-mitigated header as a wall', async () => {
    for (const init of [
      { status: 429 },
      { status: 503 },
      { status: 403, headers: { 'cf-mitigated': 'challenge' } },
    ]) {
      const r = await downloadPdf('https://example.org/a.pdf', async () => resp('x', init), {
        curlFetch: viaCurlOk,
      });
      expect(r.ok).toBe(true);
    }
  });

  it('says plainly what to install when curl-impersonate is missing', async () => {
    const r = await downloadPdf('https://example.org/a.pdf', blocked, { curlFetch: null });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/anti-bot/);
    expect(!r.ok && r.reason).toMatch(/curl-impersonate/);
    expect(!r.ok && r.reason).toMatch(/PA_CURL_IMPERSONATE/);
  });

  it('is honest when even the impersonated request is blocked', async () => {
    const r = await downloadPdf('https://example.org/a.pdf', blocked, { curlFetch: blocked });
    expect(!r.ok && r.reason).toMatch(/sigue bloqueándome/);
  });

  it('does not retry on an ordinary 404', async () => {
    let called = false;
    const r = await downloadPdf(
      'https://example.org/a.pdf',
      async () => resp('', { status: 404 }),
      {
        curlFetch: async () => {
          called = true;
          return resp(pdfBytes);
        },
      },
    );
    expect(called).toBe(false);
    expect(!r.ok && r.reason).toMatch(/error 404/);
  });

  it('keeps validating redirects on the impersonated path', async () => {
    const toPrivate: typeof fetch = async () =>
      resp('', { status: 302, headers: { location: 'http://127.0.0.1/secret.pdf' } });
    const r = await downloadPdf('https://example.org/a.pdf', blocked, { curlFetch: toPrivate });
    expect(!r.ok && r.reason).toMatch(/no permitida/);
  });

  it('keeps the size cap and the %PDF- check on the impersonated path', async () => {
    const html: typeof fetch = async () => resp('<html>login</html>');
    const r1 = await downloadPdf('https://example.org/a.pdf', blocked, { curlFetch: html });
    expect(!r1.ok && r1.reason).toMatch(/no devuelve un PDF/);
    const big: typeof fetch = async () =>
      resp(pdfBytes, { headers: { 'content-length': String(60 * 1024 * 1024) } });
    const r2 = await downloadPdf('https://example.org/a.pdf', blocked, { curlFetch: big });
    expect(!r2.ok && r2.reason).toMatch(/50 MB/);
  });
});

describe('findCurlImpersonate', () => {
  it('returns null for a configured path that does not exist', async () => {
    expect(await findCurlImpersonate(join(tmpdir(), 'no-such-curl-impersonate'))).toBeNull();
  });

  it('returns a configured path that exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pa-curl-'));
    const f = join(root, 'curl-impersonate');
    writeFileSync(f, '');
    expect(await findCurlImpersonate(f)).toBe(f);
    rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!posix)('curlImpersonateFetch with a fake binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-fakecurl-'));
  const bin = join(root, 'curl-impersonate');
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function install(headers: string, body: string, code = 0) {
    writeFileSync(
      bin,
      `#!/bin/bash
h=""; o=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-D" ]; then h="$2"; fi
  if [ "$1" = "-o" ]; then o="$2"; fi
  shift
done
printf '%b' '${headers}' > "$h"
printf '%b' '${body}' > "$o"
exit ${code}
`,
    );
    chmodSync(bin, 0o755);
  }

  it('turns curl output into a Response with status, headers and body', async () => {
    install('HTTP/2 200\\r\\ncontent-type: application/pdf\\r\\nx-a: b\\r\\n\\r\\n', '%PDF-1.4 hi');
    const res = await curlImpersonateFetch(bin)('https://example.org/a.pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-a')).toBe('b');
    expect(await res.text()).toBe('%PDF-1.4 hi');
  });

  it('uses the last header block when there are several', async () => {
    install(
      'HTTP/1.1 100 Continue\\r\\n\\r\\nHTTP/2 403\\r\\ncf-mitigated: challenge\\r\\n\\r\\n',
      'no',
    );
    const res = await curlImpersonateFetch(bin)('https://example.org/a.pdf');
    expect(res.status).toBe(403);
    expect(res.headers.get('cf-mitigated')).toBe('challenge');
  });

  it('reports a timeout and an oversize file in the words downloadPdf maps', async () => {
    install('', '', 28);
    await expect(curlImpersonateFetch(bin)('https://example.org/a.pdf')).rejects.toThrow(/timeout/);
    install('', '', 63);
    const res = await curlImpersonateFetch(bin)('https://example.org/a.pdf');
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(49 * 1024 * 1024);
  });

  it('end to end: a walled fetch is retried through the binary', async () => {
    install('HTTP/2 200\\r\\ncontent-type: application/pdf\\r\\n\\r\\n', '%PDF-1.4 ok');
    const r = await downloadPdf(
      'https://example.org/a.pdf',
      async () => resp('x', { status: 403 }),
      {
        curlImpersonatePath: bin,
      },
    );
    expect(r.ok).toBe(true);
  });
});

describe('config: curl-impersonate path', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetConfigForTests();
  });

  it('is empty by default and read from PA_CURL_IMPERSONATE', () => {
    delete process.env.PA_CURL_IMPERSONATE;
    resetConfigForTests();
    expect(loadConfig().curlImpersonatePath).toBe('');
    process.env.PA_CURL_IMPERSONATE = ' C:\\tools\\curl-impersonate.exe ';
    resetConfigForTests();
    expect(loadConfig().curlImpersonatePath).toBe('C:\\tools\\curl-impersonate.exe');
  });
});

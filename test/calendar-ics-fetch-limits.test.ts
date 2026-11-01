import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchIcsText } from '../src/agenda/ics-fetch.js';

const ICS =
  'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Dentista\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';

function streamOf(parts: Uint8Array[], hangAfter = false): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < parts.length) ctrl.enqueue(parts[i++] as Uint8Array);
      else if (!hangAfter) ctrl.close();
      // hangAfter: no cierra nunca, como un servidor que se queda a medias.
    },
  });
}

describe('calendario: lectura de la dirección iCal con topes', () => {
  it('lee un calendario normal', async () => {
    const text = await fetchIcsText('https://cal.example/x.ics', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: streamOf([new TextEncoder().encode(ICS)]),
        text: async () => ICS,
      }),
    });
    expect(text).toBe(ICS);
  });

  it('un servidor que no contesta se corta y lo dice en castellano', async () => {
    const t0 = Date.now();
    const p = fetchIcsText('https://cal.example/x.ics', {
      timeoutMs: 50,
      fetchImpl: () => new Promise(() => {}),
    });
    await expect(p).rejects.toThrow('el calendario no ha respondido en 0 segundos');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('un cuerpo que se queda a medias también se corta', async () => {
    const p = fetchIcsText('https://cal.example/x.ics', {
      timeoutMs: 1_000,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: streamOf([new TextEncoder().encode('BEGIN:VCALENDAR\r\n')], true),
        text: async () => '',
      }),
    });
    await expect(p).rejects.toThrow('no ha respondido en 1 segundos');
  });

  it('un fichero enorme no se lee entero', async () => {
    const big = new Uint8Array(64 * 1024);
    const p = fetchIcsText('https://cal.example/x.ics', {
      maxBytes: 100 * 1024,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: streamOf([big, big, big, big]),
        text: async () => '',
      }),
    });
    await expect(p).rejects.toThrow(/pesa más de/);
  });

  it('un estado de error se conserva para el aviso de siempre', async () => {
    const p = fetchIcsText('https://cal.example/x.ics', {
      fetchImpl: async () => ({ ok: false, status: 404, body: null, text: async () => '' }),
    });
    await expect(p).rejects.toThrow('el calendario ha respondido 404');
  });

  it('todas las lecturas del calendario en cli.ts pasan por los topes (también la del chat)', () => {
    const cli = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const reads = cli.split("getUrl: () => vaultGet('calendar:icsUrl'),").slice(1);
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const after of reads)
      expect(after.trimStart()).toMatch(/^fetchText: \(url\) => fetchIcsText\(url\),/);
  });
});

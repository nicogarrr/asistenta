import { describe, expect, it } from 'vitest';
import { hostOf as browserHostOf } from '../src/browser/service.js';
import { normalizeHostname, urlHostname } from '../src/text.js';
import { hostOf as downloadHostOf } from '../src/tools/download.js';
import { hostOf as priceHostOf } from '../src/watch/price-extract.js';

// Copies of the three hostOf bodies as they were before they shared urlHostname.
function oldBrowser(url: string): string | null {
  try {
    return normalizeHostname(new URL(url).hostname).replace(/^www\./, '');
  } catch {
    return null;
  }
}
function oldPricewatch(url: string): string {
  try {
    return normalizeHostname(new URL(url).hostname);
  } catch {
    return '';
  }
}
function oldDownload(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'enlace no válido';
  }
}

const FIXED = [
  'https://www.amazon.es/dp/B0',
  'https://WWW.Amazon.ES./dp/B0',
  'https://paypal.com./login',
  'https://mail.google.com../inbox',
  'http://localhost.:8080/x',
  'https://user:pw@Example.com:443/a?b#c',
  'http://[::1]:3000/',
  'http://127.0.0.1/',
  'https://xn--espaa-rta.es/',
  'https://españa.es/',
  'file:///etc/passwd',
  'data:text/plain,hola',
  'mailto:a@b.com',
  'https://www./',
  'https://www.www.example.com/',
  'not a url',
  '',
  'https://',
  'https://exa mple.com/',
  'javascript:alert(1)',
];

function corpus(): string[] {
  const out = [...FIXED];
  const labels = [
    'www',
    'WWW',
    'amazon',
    'Ebay',
    'pccomponentes',
    'es',
    'COM',
    'internal',
    'local',
  ];
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let i = 0; i < 400; i++) {
    const parts = Array.from({ length: 1 + rnd(4) }, () => labels[rnd(labels.length)]);
    const dots = '.'.repeat(rnd(3));
    const scheme = ['https://', 'http://', 'HTTPS://'][rnd(3)];
    out.push(`${scheme}${parts.join('.')}${dots}${rnd(2) ? `:${1000 + rnd(9000)}` : ''}/p?q=${i}`);
  }
  return out;
}

describe('hostOf unificado sobre urlHostname', () => {
  it('urlHostname = normalizeHostname(new URL(u).hostname), o null si no es URL', () => {
    expect(urlHostname('https://Amazon.ES./x')).toBe('amazon.es');
    expect(urlHostname('https://mail.google.com../')).toBe('mail.google.com');
    expect(urlHostname('no es url')).toBeNull();
    expect(urlHostname('file:///x')).toBe('');
  });

  it('browser/service.ts hostOf: idéntico al anterior en todo el corpus', () => {
    for (const u of corpus()) expect(browserHostOf(u), u).toBe(oldBrowser(u));
  });

  it('watch/price-extract.ts hostOf: idéntico al anterior en todo el corpus', () => {
    for (const u of corpus()) expect(priceHostOf(u), u).toBe(oldPricewatch(u));
  });

  it('tools/download.ts hostOf: el anterior normalizado (nunca más laxo), etiqueta igual si no es URL', () => {
    for (const u of corpus()) {
      const before = oldDownload(u);
      const expected = before === 'enlace no válido' ? before : normalizeHostname(before);
      expect(downloadHostOf(u), u).toBe(expected);
    }
  });

  it('una descarga de «Example.COM.» se registra con el mismo host que el navegador', () => {
    expect(downloadHostOf('https://WWW.Example.COM./f.pdf')).toBe('www.example.com');
    expect(browserHostOf('https://WWW.Example.COM./f.pdf')).toBe('example.com');
    expect(priceHostOf('https://WWW.Example.COM./f.pdf')).toBe('www.example.com');
  });
});

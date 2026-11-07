import { describe, expect, it } from 'vitest';
import { type TailscaleRun, tailscaleCommand } from '../src/tailscale.js';
import {
  isTelegramFrame,
  pageCsp,
  panelAllowedHosts,
  parsePanelPublicUrl,
  startWebUi,
} from '../src/webui/server.js';

const TOKEN = 'x'.repeat(32);

async function withPanel<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const ui = await startWebUi({
    token: TOKEN,
    status: () => ({}),
    sessions: () => [],
    memory: () => [],
    auditVerify: () => ({}),
  });
  try {
    return await fn(ui.url.replace(/\/$/, ''));
  } finally {
    await ui.close();
  }
}

describe('panel-tg: cabeceras de marco por origen', () => {
  it('Telegram Web en iframe puede enmarcar / y /voz; nadie más', async () => {
    await withPanel(async (base) => {
      for (const path of ['/', '/voz']) {
        const tg = await fetch(base + path, {
          headers: { 'sec-fetch-dest': 'iframe', referer: 'https://web.telegram.org/k/' },
        });
        expect(tg.headers.get('x-frame-options')).toBeNull();
        const csp = tg.headers.get('content-security-policy') ?? '';
        expect(csp).toContain('frame-ancestors https://web.telegram.org https://*.telegram.org');
        expect(csp).not.toContain("frame-ancestors 'none'");

        const evil = await fetch(base + path, {
          headers: { 'sec-fetch-dest': 'iframe', referer: 'https://evil.example/' },
        });
        expect(evil.headers.get('x-frame-options')).toBe('DENY');
        expect(evil.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

        const plain = await fetch(base + path);
        expect(plain.headers.get('x-frame-options')).toBe('DENY');
        expect(plain.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      }
      // La API nunca se deja enmarcar.
      const api = await fetch(`${base}/api/status`, {
        headers: { 'sec-fetch-dest': 'iframe', referer: 'https://web.telegram.org/' },
      });
      expect(api.headers.get('x-frame-options')).toBe('DENY');
    });
  });

  it('isTelegramFrame: solo iframe y solo https de telegram.org', () => {
    const f = (h: Record<string, string>) => isTelegramFrame(h);
    expect(f({ 'sec-fetch-dest': 'iframe', referer: 'https://web.telegram.org/a/' })).toBe(true);
    expect(f({ 'sec-fetch-dest': 'iframe' })).toBe(true);
    expect(f({ 'sec-fetch-dest': 'document', referer: 'https://web.telegram.org/' })).toBe(false);
    expect(f({ 'sec-fetch-dest': 'iframe', referer: 'http://web.telegram.org/' })).toBe(false);
    expect(f({ 'sec-fetch-dest': 'iframe', referer: 'https://telegram.org.evil.example/' })).toBe(
      false,
    );
    expect(f({ 'sec-fetch-dest': 'iframe', referer: 'https://eviltelegram.org/' })).toBe(false);
    expect(f({ referer: 'https://web.telegram.org/' })).toBe(false);
    expect(pageCsp(false)).toContain("frame-ancestors 'none'");
  });
});

describe('panel-tg: PA_PANEL_PUBLIC_URL', () => {
  const noTailscale: TailscaleRun = async () => null;

  it('normaliza la URL https y rechaza http', () => {
    expect(parsePanelPublicUrl('https://laptop-82hme98s.tailae34cd.ts.net')).toBe(
      'https://laptop-82hme98s.tailae34cd.ts.net/',
    );
    expect(parsePanelPublicUrl('http://laptop.ts.net/')).toBe('');
    expect(parsePanelPublicUrl('https://u:p@laptop.ts.net/')).toBe('');
    expect(parsePanelPublicUrl('')).toBe('');
  });

  it('su nombre entra solo en los hosts permitidos', () => {
    expect(
      panelAllowedHosts({ PA_PANEL_PUBLIC_URL: 'https://Laptop-82hme98s.tailae34cd.ts.net/' }),
    ).toEqual(['laptop-82hme98s.tailae34cd.ts.net']);
    expect(panelAllowedHosts({ PA_WEB_ALLOWED_HOSTS: 'a.ts.net' })).toEqual(['a.ts.net']);
  });

  it('/panel y /voz usan esa URL aunque no se pueda leer Tailscale', async () => {
    const env = { PA_PANEL_PUBLIC_URL: 'https://laptop-82hme98s.tailae34cd.ts.net' };
    const panel = await tailscaleCommand('panel', { env, run: noTailscale });
    expect(panel.buttons?.[0]?.action).toBe('webapp:https://laptop-82hme98s.tailae34cd.ts.net/');
    const voz = await tailscaleCommand('voz', { env, run: noTailscale });
    expect(voz.buttons?.[0]?.action).toBe('webapp:https://laptop-82hme98s.tailae34cd.ts.net/voz');
  });

  it('una URL no https se explica en vez de dar un botón roto', async () => {
    const r = await tailscaleCommand('panel', {
      env: { PA_PANEL_PUBLIC_URL: 'http://192.168.1.10:8787' },
      run: noTailscale,
    });
    expect(r.buttons).toBeUndefined();
    expect(r.text).toContain('https');
  });
});

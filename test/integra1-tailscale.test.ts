import { describe, expect, it } from 'vitest';
import { buildKeyboard, usableButtons } from '../src/channels/telegram.js';
import {
  readTailscale,
  type TailscaleRun,
  tailscaleCommand,
  tailscaleExe,
} from '../src/tailscale.js';
import { signInitData, verifyInitData } from '../src/webui/miniapp.js';
import { startWebUi } from '../src/webui/server.js';

const STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'mi-pc.cola-123.ts.net.', TailscaleIPs: ['100.64.1.2', 'fd7a::1'] },
});
const SERVE = JSON.stringify({
  TCP: { '443': { HTTPS: true } },
  Web: { 'mi-pc.cola-123.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } } },
});
const run =
  (status: string | null, serve: string | null = SERVE): TailscaleRun =>
  async (args) =>
    args[0] === 'status' ? status : serve;

describe('Tailscale: /tailscale y /panel', () => {
  it('sin Tailscale instalado lo dice y apunta a la guía', async () => {
    const r = await tailscaleCommand('estado', { env: {}, run: run(null) });
    expect(r.text).toContain('Tailscale no está instalado');
    expect(r.text).toContain('SETUP-INTEGRACIONES');
  });

  it('lee el nombre MagicDNS, la IP 100.x y si serve publica el panel', async () => {
    const info = await readTailscale(run(STATUS), 8787);
    expect(info).toMatchObject({
      installed: true,
      running: true,
      dnsName: 'mi-pc.cola-123.ts.net',
      ip: '100.64.1.2',
      serving: true,
      funnel: false,
    });
    expect((await readTailscale(run(STATUS, '{}'), 8787)).serving).toBe(false);
  });

  it('sin serve dice el comando exacto; sin PA_WEB_ALLOWED_HOSTS, la línea exacta', async () => {
    const a = await tailscaleCommand('estado', { env: {}, run: run(STATUS, '{}') });
    expect(a.text).toContain('tailscale serve --bg 8787');
    const b = await tailscaleCommand('panel', { env: {}, run: run(STATUS) });
    expect(b.buttons).toBeUndefined();
    expect(b.text).toContain('PA_WEB_ALLOWED_HOSTS=mi-pc.cola-123.ts.net');
  });

  it('con todo listo /panel da el botón de Mini App con la dirección https', async () => {
    const env = { PA_WEB_ALLOWED_HOSTS: 'mi-pc.cola-123.ts.net' };
    const r = await tailscaleCommand('panel', { env, run: run(STATUS) });
    expect(r.buttons).toEqual([
      { label: '📱 Abrir panel', action: 'webapp:https://mi-pc.cola-123.ts.net/' },
    ]);
    const kb = buildKeyboard(r.buttons ?? []);
    expect(JSON.stringify(kb.inline_keyboard)).toContain(
      '"web_app":{"url":"https://mi-pc.cola-123.ts.net/"}',
    );
    expect(usableButtons([{ label: 'x', action: 'webapp:http://inseguro' }])).toEqual([]);
  });

  it('con funnel encendido avisa y no da botón', async () => {
    const serve = JSON.stringify({
      ...JSON.parse(SERVE),
      AllowFunnel: { 'mi-pc.cola-123.ts.net:443': true },
    });
    const env = { PA_WEB_ALLOWED_HOSTS: 'mi-pc.cola-123.ts.net' };
    const r = await tailscaleCommand('panel', { env, run: run(STATUS, serve) });
    expect(r.buttons).toBeUndefined();
    expect(r.text).toContain('funnel');
  });

  it('en Windows usa la CLI de Program Files si existe', () => {
    expect(tailscaleExe('win32', () => true)).toContain('Program Files\\Tailscale');
    expect(tailscaleExe('linux', () => true)).toBe('tailscale');
  });
});

const BOT = '123456:ABC-fake';
function initData(userId: number, authDate: number, token = BOT): string {
  const fields = {
    auth_date: String(authDate),
    query_id: 'AAH',
    user: JSON.stringify({ id: userId, first_name: 'Nico' }),
  };
  return new URLSearchParams({ ...fields, hash: signInitData(fields, token) }).toString();
}

describe('Mini App: entrar al panel con la firma de Telegram', () => {
  const now = 1_800_000_000_000;
  it('acepta solo al dueño, firmado por este bot y reciente', () => {
    expect(verifyInitData(initData(42, now / 1000), BOT, 42, now)).toBe(true);
    expect(verifyInitData(initData(7, now / 1000), BOT, 42, now)).toBe(false);
    expect(verifyInitData(initData(42, now / 1000, 'otro:bot'), BOT, 42, now)).toBe(false);
    expect(verifyInitData(initData(42, now / 1000 - 3 * 86400), BOT, 42, now)).toBe(false);
    expect(verifyInitData(initData(42, now / 1000), undefined, 42, now)).toBe(false);
    expect(verifyInitData(initData(42, now / 1000), BOT, null, now)).toBe(false);
  });

  it('/api/miniapp devuelve el token solo con initData válido', async () => {
    const web = await startWebUi({
      token: 't'.repeat(32),
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
      miniApp: (d) => verifyInitData(d, BOT, 42),
    });
    try {
      const post = (initData: string) =>
        fetch(`${web.url}/api/miniapp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        });
      const ok = await post(initData(42, Math.floor(Date.now() / 1000)));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ token: 't'.repeat(32) });
      const bad = await post(initData(7, Math.floor(Date.now() / 1000)));
      expect(bad.status).toBe(401);
      expect((await bad.json()).token).toBeUndefined();
    } finally {
      await web.close();
    }
  });
});

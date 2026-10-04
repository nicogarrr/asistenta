import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserService,
  classifyChallenge,
  isMissingBrowserError,
} from '../src/browser/service.js';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import { challengeNote } from '../src/tools/browser.js';

describe('classifyChallenge', () => {
  const base = {
    url: 'https://shop.example/p/1',
    title: 'Producto',
    text: 'Añadir al carrito',
    frames: [] as string[],
  };

  it('recognises the Cloudflare interstitial', () => {
    expect(
      classifyChallenge({
        ...base,
        title: 'Just a moment...',
        text: 'Verifying you are human. This may take a few seconds.',
        frames: ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile'],
      }),
    ).toBe('cloudflare');
  });

  it('recognises a reCAPTCHA wall, a hCaptcha wall and Google "sorry"', () => {
    expect(
      classifyChallenge({
        ...base,
        text: "Please verify you are human. I'm not a robot",
        frames: ['https://www.google.com/recaptcha/api2/bframe?hl=es'],
      }),
    ).toBe('recaptcha');
    expect(
      classifyChallenge({
        ...base,
        text: 'No soy un robot',
        frames: ['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html'],
      }),
    ).toBe('hcaptcha');
    expect(
      classifyChallenge({ ...base, url: 'https://www.google.com/sorry/index?continue=x' }),
    ).toBe('recaptcha');
  });

  it('catches Spanish wording on an unknown vendor', () => {
    expect(classifyChallenge({ ...base, text: 'Verifica que eres un humano para continuar' })).toBe(
      'verify_human',
    );
  });

  it('does not flag articles that talk about captchas or have "un momento" in the title', () => {
    const long = `${'Lorem ipsum dolor sit amet. '.repeat(60)} Cómo saber si eres un humano: verifica que eres un humano.`;
    expect(
      classifyChallenge({ ...base, title: 'Un momento para recordar - Blog', text: long }),
    ).toBeNull();
    expect(
      classifyChallenge({ ...base, title: 'Cómo funciona un captcha', text: long }),
    ).toBeNull();
    expect(
      classifyChallenge({ ...base, title: 'Security check-in tips', text: 'Hola' }),
    ).toBeNull();
  });

  it('a title with a site suffix is not an interstitial', () => {
    expect(classifyChallenge({ ...base, title: 'Un momento - Mi blog', text: 'Hola' })).toBeNull();
    expect(
      classifyChallenge({ ...base, title: 'Un momento – Diario de viaje', text: 'Hola' }),
    ).toBeNull();
  });

  it('still flags the short real interstitials', () => {
    expect(classifyChallenge({ ...base, title: 'Un momento...', text: 'Verificando' })).toBe(
      'verify_human',
    );
    expect(
      classifyChallenge({
        ...base,
        title: 'Attention Required! | Cloudflare',
        text: 'Cloudflare Ray ID: 8a',
      }),
    ).toBe('cloudflare');
  });

  it('leaves normal pages alone, including one that only embeds a widget', () => {
    expect(classifyChallenge(base)).toBeNull();
    expect(
      classifyChallenge({
        ...base,
        title: 'Crear cuenta',
        text: 'Correo Contraseña Registrarse',
        frames: ['https://challenges.cloudflare.com/turnstile/v0/b/x/widget'],
      }),
    ).toBeNull();
    expect(
      classifyChallenge({
        ...base,
        text: 'Contacto',
        frames: ['https://www.google.com/recaptcha/api2/anchor?size=normal'],
      }),
    ).toBeNull();
  });
});

describe('isMissingBrowserError', () => {
  it('matches the Playwright "not installed" messages and nothing else', () => {
    expect(
      isMissingBrowserError(
        new Error(
          "browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        ),
      ),
    ).toBe(true);
    expect(
      isMissingBrowserError(new Error("Executable doesn't exist at /x/chromium-1234/chrome")),
    ).toBe(true);
    expect(isMissingBrowserError(new Error('The profile is already in use'))).toBe(false);
  });
});

describe('BrowserService: challenge detection and installed-browser fallback (live)', () => {
  let server: Server;
  let base = '';
  const root = mkdtempSync(join(tmpdir(), 'pa-antibot-'));
  const approvals: string[] = [];
  const services: BrowserService[] = [];

  function make(channel?: 'chrome' | 'chromium') {
    const s = new BrowserService({
      policy: {
        allowPrivateHosts: true,
        approve: async (_scope, domain) => {
          approvals.push(domain);
          return true;
        },
      },
      profilesDir: join(root, `profiles-${services.length}`),
      timeoutMs: 30_000,
      channel,
    });
    services.push(s);
    return s;
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url === '/wall') {
        res.end(
          '<title>Just a moment...</title><body><h1>Verifying you are human</h1><p>cloudflare ray id: 1</p>',
        );
      } else {
        res.end('<title>Tienda</title><body><button>Comprar</button></body>');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(services.map((s) => s.closeAll()));
    await new Promise((r) => server.close(r));
    rmSync(root, { recursive: true, force: true });
  });

  it('detects a challenge page and stays quiet on a normal one', async () => {
    const service = make();
    await service.open('t#1', `${base}/wall`);
    expect((await service.detectChallenge('t#1'))?.kind).toBe('cloudflare');
    await service.open('t#1', `${base}/ok`);
    expect(await service.detectChallenge('t#1')).toBeNull();
  });

  it('challengeNote sends the screenshot, shows the window and does not claim success', async () => {
    const service = make();
    await service.open('t#2', `${base}/wall`);
    const sent: number[] = [];
    const note = await challengeNote(service, 't#2', async (png) => {
      sent.push(png.length);
      return true;
    });
    expect(note?.text).toMatch(/^captcha_detectado \(cloudflare\)/);
    expect(note?.text).toMatch(/No digas que la tarea está hecha/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeGreaterThan(100);
  });

  it('challengeNote says so when the screenshot could not be sent', async () => {
    const service = make();
    await service.open('t#3', `${base}/wall`);
    const note = await challengeNote(service, 't#3', async () => false);
    expect(note?.text).toMatch(/No pude enviar la captura/);
  });

  it('challengeNote returns null on a normal page', async () => {
    const service = make();
    await service.open('t#4', `${base}/ok`);
    expect(await challengeNote(service, 't#4')).toBeNull();
  });

  it('asks for Chrome and still works when it is not installed (falls back to chromium)', async () => {
    const service = make('chrome');
    const info = await service.open('t#5', `${base}/ok`);
    expect(info.title).toBe('Tienda');
  });
});

describe('config: browser channel', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetConfigForTests();
  });

  it('defaults to the installed Chrome, accepts msedge and rejects a typo', () => {
    delete process.env.PA_BROWSER_CHANNEL;
    resetConfigForTests();
    expect(loadConfig().browserChannel).toBe('chrome');
    process.env.PA_BROWSER_CHANNEL = 'msedge';
    resetConfigForTests();
    expect(loadConfig().browserChannel).toBe('msedge');
    process.env.PA_BROWSER_CHANNEL = 'crome';
    resetConfigForTests();
    expect(() => loadConfig()).toThrow(/PA_BROWSER_CHANNEL/);
  });
});

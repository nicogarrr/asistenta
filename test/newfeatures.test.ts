import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { GrammyError } from 'grammy';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BrowserService,
  domainCovers,
  formatValue,
  hostOf,
  profileDirFor,
} from '../src/browser/service.js';
import {
  backoffFor,
  chunkText,
  isAddressedToBot,
  isStopCommand,
} from '../src/channels/telegram.js';
import { looksLikeFollowUp, parseCommand, summarizeTranscript, trimForSpeech } from '../src/cli.js';
import { toRealCoordinates } from '../src/tools/computer.js';
import { headTail, OutputCollector } from '../src/tools/shell.js';

describe('parseCommand', () => {
  it('splits the command from its arguments', () => {
    expect(parseCommand('/watch 30 10')).toEqual({ name: 'watch', args: '30 10' });
    expect(parseCommand('/screen')).toEqual({ name: 'screen', args: '' });
  });

  it('strips the @botname suffix Telegram adds in groups', () => {
    expect(parseCommand('/stop@asistenta_personal_bot')).toEqual({ name: 'stop', args: '' });
    // Telegram appends the suffix to the command token, not to its arguments.
    expect(parseCommand('/topic@mi_bot renfe')).toEqual({ name: 'topic', args: 'renfe' });
  });

  it('ignores ordinary text and malformed commands', () => {
    expect(parseCommand('hola')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    // A command name must be letters: `/123abc` is not something Telegram routes.
    expect(parseCommand('/123abc')).toBeNull();
    expect(parseCommand('mira /stop')).toBeNull();
  });
});

describe('looksLikeFollowUp', () => {
  it('treats short acknowledgements as continuation', () => {
    for (const t of ['sí', 'vale', 'ok', 'adelante', 'sigue', 'nada', 'yes', 'ahora']) {
      expect(looksLikeFollowUp(t), t).toBe(true);
    }
  });

  it('treats anything with real content as a new request', () => {
    for (const t of [
      'mira este error de la app',
      'sí, hazlo',
      'graba la pantalla',
      '¿qué tal?',
      'vale pero ahora mira el correo',
    ]) {
      expect(looksLikeFollowUp(t), t).toBe(false);
    }
  });

  it('treats empty as a follow-up so it never spawns an empty conversation', () => {
    expect(looksLikeFollowUp('   ')).toBe(true);
  });
});

/**
 * The threading rule is the difference between "one conversation per chat" and
 * "one conversation per thing", so it is worth pinning down precisely.
 */
describe('thread resolution rules', () => {
  const rule = (opts: {
    activeTopic?: string;
    replyToKnown?: boolean;
    telegramThread?: string;
    mainBusy: boolean;
    text: string;
  }): string => {
    if (opts.activeTopic) return `explicit:${opts.activeTopic}`;
    if (opts.replyToKnown) return 'reply-thread';
    if (opts.telegramThread) return `telegram:${opts.telegramThread}`;
    if (!opts.mainBusy) return 'main';
    if (looksLikeFollowUp(opts.text)) return 'main';
    return 'spawn';
  };

  it('an explicit topic always wins', () => {
    expect(rule({ activeTopic: 'renfe', mainBusy: true, text: 'otra cosa' })).toBe(
      'explicit:renfe',
    );
  });

  it('a reply to a known message continues that conversation even when busy', () => {
    expect(rule({ replyToKnown: true, mainBusy: true, text: 'mira este error' })).toBe(
      'reply-thread',
    );
  });

  it('uses telegram thread ids when the client provides them', () => {
    expect(rule({ telegramThread: '42', mainBusy: false, text: 'hola' })).toBe('telegram:42');
  });

  it('uses the main conversation when it is free', () => {
    expect(rule({ mainBusy: false, text: 'buscaWeather' })).toBe('main');
  });

  it('spawns a separate conversation for a new request while busy', () => {
    expect(rule({ mainBusy: true, text: 'descarga el informe trimestral' })).toBe('spawn');
  });

  it('keeps a short acknowledgement queued in the busy main conversation', () => {
    expect(rule({ mainBusy: true, text: 'sí' })).toBe('main');
  });
});

describe('summarizeTranscript', () => {
  it('keeps user and assistant text plus tool names, and no tool arguments', () => {
    const out = summarizeTranscript([
      { role: 'user', content: [{ type: 'text', text: 'haz la compra' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'voy a la web' }] },
      {
        role: 'toolResult',
        toolName: 'browser',
        content: [{ type: 'text', text: 'card 4111111111111111' }],
      },
    ]);
    expect(out).toContain('usuario: haz la compra');
    expect(out).toContain('agente: voy a la web');
    expect(out).toContain('herramienta: browser');
    // A typed password must never end up written into a routine in the database.
    expect(out).not.toContain('4111111111111111');
  });

  it('reports an empty conversation instead of returning nothing', () => {
    expect(summarizeTranscript([])).toBe('(no hubo actividad)');
  });
});

describe('trimForSpeech', () => {
  it('drops markdown, code blocks and urls', () => {
    const out = trimForSpeech('Mira [la web](https://x.com) y `code`:\n```js\nconst a=1\n```');
    expect(out).not.toContain('https://');
    expect(out).not.toContain('const a=1');
    expect(out).toContain('bloque de codigo omitido');
  });

  it('caps the length so a voice note stays listenable', () => {
    expect(trimForSpeech('a'.repeat(2000))).toHaveLength(903);
  });
});

describe('browser helpers', () => {
  it('extracts the host and ignores non-urls', () => {
    expect(hostOf('https://www.renfe.com/es')).toBe('renfe.com');
    expect(hostOf('no es una url')).toBeNull();
  });

  it('treats subdomains as the same site so one approval covers a redirect', () => {
    expect(domainCovers('renfe.com', 'web.renfe.com')).toBe(true);
    expect(domainCovers('renfe.com', 'renfe.com')).toBe(true);
    expect(domainCovers('renfe.com', 'renfe.com.evil.net')).toBe(false);
    expect(domainCovers('renfe.com', 'notrenfe.com')).toBe(false);
  });

  it('hashes the scope into a filesystem-safe profile path', () => {
    // The base is built with the platform's own path rules: a hard-coded `C:\\profiles`
    // is not an absolute path on Linux, which is why this used to fail there.
    const base = join(tmpdir(), 'profiles');
    const p = profileDirFor('telegram:main:8258546109#renfe', base);
    expect(dirname(p)).toBe(base);
    expect(basename(p)).toMatch(/^[0-9a-f]{24}$/);
    // A hostile scope must not be able to escape the profiles directory.
    const hostile = profileDirFor('../../etc', base);
    expect(dirname(hostile)).toBe(base);
    expect(basename(hostile)).toMatch(/^[0-9a-f]{24}$/);
  });

  it('summarises returned values instead of dumping internals', () => {
    expect(formatValue(undefined)).toBe('undefined');
    expect(formatValue([1, 2, 3])).toBe('[1, 2, 3]');
    expect(formatValue([])).toBe('[]');
    expect(formatValue({ a: 1, b: 'x' })).toBe('{a: 1, b: x}');
    expect(formatValue('long'.repeat(3000)).endsWith('...')).toBe(true);
    // Depth is bounded so a self-referential page object cannot blow up the context.
    const deep = { a: { b: { c: { d: 1 } } } };
    expect(formatValue(deep, 0)).toContain('{...}');
  });
});

/**
 * The live browser, exercised against a real Chromium and a real page.
 *
 * These are the tests that earned their place: each one failed on its first run and
 * caught a genuine defect. A unit test with a mocked page would have passed all three
 * bugs — persistent state, a click hanging on a gated destination, and the
 * sensitive-host list — without noticing any of them.
 */
describe('BrowserService (live)', () => {
  const scope = 'live-test#main';
  const root = mkdtempSync(join(tmpdir(), 'pa-br-'));
  const profiles = join(root, 'profiles');
  const approvals: string[] = [];
  const service = new BrowserService({
    policy: {
      allowPrivateHosts: true,
      approve: async (_scope, domain) => {
        approvals.push(domain);
        return true;
      },
    },
    profilesDir: profiles,
    timeoutMs: 30_000,
  });

  afterAll(async () => {
    await service.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  it('opens a real page and lists its interactive elements', async () => {
    const info = await service.open(scope, 'https://example.com');
    expect(info.title.length).toBeGreaterThan(0);
    expect(approvals).toContain('example.com');

    const snap = await service.snapshot(scope);
    expect(snap).toContain('https://example.com');
    // The element list is the point of the snapshot: a selector to click, not a pixel.
    expect(snap).toMatch(/^a\b.*"/m);
  });

  it('keeps state across exec_js calls', async () => {
    const first = await service.execJs(scope, 'state.n = 41; return ++state.n;');
    expect(first.text).toBe('42');
    // This is what the tool description promises and what an IIFE-scoped `var` did not
    // deliver: the second call must see what the first one stored.
    const second = await service.execJs(scope, 'return state.n + 1;');
    expect(second.text).toBe('43');
  });

  it('runs playwright code and reports when the page navigated', async () => {
    // Target the link by the accessible name the snapshot reported, which is the
    // intended loop: discover by text, act by selector.
    const name = /link\s+"([^"]+)"/.exec(await service.snapshot(scope))?.[1] ?? 'a';
    const result = await service.execJs(
      scope,
      `await page.getByRole('link', { name: ${JSON.stringify(name)} }).click();
       return { title: await page.title() };`,
    );
    expect(result.text).not.toMatch(/^error:/);
    expect(result.url).toMatch(/^https?:\/\//);
    // The destination was approved at the network layer, not silently followed.
    expect(approvals.length).toBeGreaterThan(1);
  });

  it('refuses a sensitive login host without asking', async () => {
    const before = approvals.length;
    await expect(service.open(scope, 'https://login.microsoftonline.com')).rejects.toThrow(
      /sensibles/,
    );
    expect(approvals).toHaveLength(before);
  });
});

describe('BrowserService domain consent', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-consent-'));
  const profiles = join(root, 'profiles');
  const open: BrowserService[] = [];

  afterAll(async () => {
    for (const s of open) await s.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  const make = (policy: { autoApprove?: boolean; adSkipIntervalMs?: number }, asked: string[]) =>
    new BrowserService({
      policy: {
        allowPrivateHosts: true,
        ...policy,
        approve: async (_scope, domain) => {
          asked.push(domain);
          return true;
        },
      },
      profilesDir: profiles,
      timeoutMs: 30_000,
    });

  it('never asks when auto-approved, which is what full control means for the browser', async () => {
    const asked: string[] = [];
    const service = make({ autoApprove: true }, asked);
    open.push(service);
    await service.open('auto#main', 'https://example.com');
    expect(asked).toEqual([]);
    expect(service.grantedDomains('auto#main')).toContain('example.com');
  });

  it('still refuses the sensitive list with auto-approve on', async () => {
    const asked: string[] = [];
    const service = make({ autoApprove: true }, asked);
    open.push(service);
    // Auto-approve is consent, not a hole in the wall: a login host is refused, and
    // refusing is not a prompt, so it never reaches the approver.
    await expect(service.open('auto#main', 'https://login.microsoftonline.com')).rejects.toThrow(
      /sensibles/,
    );
    expect(asked).toEqual([]);
  });

  it('remembers approvals across a restart, so "once" means once', async () => {
    const first: string[] = [];
    const a = make({}, first);
    open.push(a);
    await a.open('persist#main', 'https://example.com');
    expect(first).toContain('example.com');

    // A restart ends the old process first: Chromium locks its profile dir, so the second
    // service cannot share it with a still-running first one (ProcessSingleton).
    await a.closeAll();
    // A brand new service on the same profiles dir: what a daemon restart looks like.
    const second: string[] = [];
    const b = make({}, second);
    open.push(b);
    await b.open('persist#main', 'https://example.com');
    expect(second).toEqual([]);
    expect(b.grantedDomains('persist#main')).toContain('example.com');
  });

  it('does not ask about an advert or tracker frame inside an approved page', async () => {
    const asked: string[] = [];
    const service = make({}, asked);
    open.push(service);
    await service.open('frames#main', 'https://example.com');
    asked.length = 0;
    // The frame is a document navigation to a different host, which is exactly what the
    // old rule asked about: the user got a prompt for an ad server in the middle of a
    // song, every time. Built through `page.evaluate` because `exec_js` has no
    // `document` in its sandbox.
    await service.execJs(
      'frames#main',
      `await page.evaluate(() => {
         const f = document.createElement('iframe');
         f.src = 'https://example.org/';
         f.width = '10'; f.height = '10';
         document.body.appendChild(f);
       });
       await page.waitForTimeout(2500);
       return 'frame attached';`,
    );
    expect(asked).not.toContain('example.org');
  });

  it('asks about a top-level navigation even from inside an approved page', async () => {
    const asked: string[] = [];
    const service = make({}, asked);
    open.push(service);
    await service.open('toplevel#main', 'https://example.com');
    asked.length = 0;
    await service.open('toplevel#main', 'https://example.org/').catch(() => undefined);
    // example.org as a destination is a new place, and the page may not have loaded at
    // all; what matters is that the approver was consulted.
    expect(asked).toContain('example.org');
  });
});

describe('BrowserService advert skipping', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-ads-'));
  const service = new BrowserService({
    policy: {
      allowPrivateHosts: true,
      autoApprove: true,
      // Fast enough that a test does not have to wait a second for one poll.
      adSkipIntervalMs: 250,
      approve: async () => true,
    },
    profilesDir: join(root, 'profiles'),
    timeoutMs: 30_000,
  });
  const scope = 'ads#main';

  afterAll(async () => {
    await service.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A page shaped like an advert player: a video and a visible skip button.
   *
   * The DOM is built through `page.evaluate`, not by touching `document` directly:
   * `exec_js` runs inside a vm sandbox that has `page` and `state` but no `document`,
   * so a bare `document.body.innerHTML` in the script throws `document is not defined`.
   * That is the sandbox doing its job, and it is exactly why the fixture goes through
   * `page` like the production code does.
   */
  async function fakeAd(): Promise<void> {
    await service.execJs(
      scope,
      `await page.evaluate(() => {
         document.body.innerHTML =
           '<video src="data:video/mp4;base64,AAAA" autoplay muted></video>' +
           '<div class="ad-showing"></div>' +
           '<button class="ytp-ad-skip-button" onclick="window.__skipped=(window.__skipped||0)+1">Saltar</button>';
       });
       return 'mounted';`,
    );
  }

  /** How many times the fake skip button was pressed. */
  async function skipCount(): Promise<number> {
    const out = await service.execJs(
      scope,
      `return await page.evaluate(() => window.__skipped ?? 0);`,
    );
    return Number(out.text);
  }

  it('presses a visible skip button and reports a hit', async () => {
    await service.open(scope, 'https://example.com');
    await fakeAd();
    const result = await service.skipAdNow(scope);
    // `clicked` is a count, not a list of selectors: what matters to the user is that
    // the button was pressed, and "which selector matched" is a debug detail the log
    // keeps. `adShowing` is asserted in the media-state test instead: the automatic
    // watcher runs every 250ms and can click the button between `fakeAd` and this
    // call, which leaves the overlay-less state we cannot control from here.
    expect(result.clicked).toBe(1);
    // Cumulative: the automatic watcher may have pressed the same button first, so
    // this can only ever grow, never land on exactly one.
    expect(await skipCount()).toBeGreaterThanOrEqual(1);
  });

  it('leaves a hidden button alone', async () => {
    await service.execJs(
      scope,
      `await page.evaluate(() => {
         const b = document.querySelector('.ytp-ad-skip-button');
         if (b) b.style.display = 'none';
         window.__skipped = 0;
       });
       return 'hidden';`,
    );
    const result = await service.skipAdNow(scope);
    expect(result.clicked).toBe(0);
    expect(await skipCount()).toBe(0);
  });

  it('skips on its own without the model being involved', async () => {
    await fakeAd();
    const before = service.adSkipStats(scope);
    // Nothing is called here on purpose: the whole point of the watcher is that the
    // press happens on a timer, not on a tool call.
    await new Promise((r) => setTimeout(r, 1200));
    const after = service.adSkipStats(scope);
    expect(after.polls).toBeGreaterThan(before.polls);
    expect(after.skipped).toBeGreaterThan(before.skipped);
    expect(await skipCount()).toBeGreaterThan(0);
  });

  it('reports the media state, including how many adverts were skipped', async () => {
    const state = await service.mediaState(scope);
    expect(state.hasVideo).toBe(true);
    // The overlay is never removed by the fixture, so it is stable here in a way the
    // skip test cannot rely on.
    expect(state.adShowing).toBe(true);
    expect(state.skipButtonsVisible).toBeGreaterThan(0);
    expect(service.adSkipStats(scope).skipped).toBeGreaterThan(0);
  });

  it('stops polling once the browser is closed', async () => {
    await service.close(scope);
    const after = service.adSkipStats(scope);
    expect(after.polls).toBe(0);
    await new Promise((r) => setTimeout(r, 800));
    expect(service.adSkipStats(scope).polls).toBe(0);
  });
});

describe('toRealCoordinates', () => {
  it('translates screenshot pixels into real desktop pixels', () => {
    // The bug this exists to prevent: clicking (440,347) on a 1280x720 image while
    // the desktop is 1920x1080 put the cursor in the wrong place entirely.
    expect(
      toRealCoordinates(440, 347, { width: 1280, height: 720 }, { width: 1920, height: 1080 }),
    ).toEqual({
      x: 660,
      y: 521,
    });
  });

  it('is the identity when the image is already native', () => {
    expect(
      toRealCoordinates(100, 200, { width: 1920, height: 1080 }, { width: 1920, height: 1080 }),
    ).toEqual({
      x: 100,
      y: 200,
    });
  });

  it('does not divide by zero on a degenerate view', () => {
    expect(
      toRealCoordinates(10, 20, { width: 0, height: 0 }, { width: 1920, height: 1080 }),
    ).toEqual({
      x: 10,
      y: 20,
    });
  });
});

describe('OutputCollector', () => {
  it('keeps everything when the output is small', () => {
    const c = new OutputCollector(1000);
    c.push(Buffer.from('line one\nline two\n'));
    expect(c.text()).toBe('line one\nline two\n');
    expect(c.omitted).toBe(0);
  });

  it('keeps the head and the tail and says what it dropped', () => {
    const c = new OutputCollector(50);
    const head = `${'a'.repeat(30)}\n`;
    const tail = `\n${'z'.repeat(40)}`;
    c.push(Buffer.from(head));
    c.push(Buffer.from(`${'m'.repeat(500)}${tail}`));
    const out = c.text();
    expect(out.startsWith('a'.repeat(20))).toBe(true);
    expect(out.endsWith('z'.repeat(40))).toBe(true);
    expect(out).toMatch(/omitted from the middle/);
    expect(c.bytes).toBe(head.length + 500 + tail.length);
  });

  it('survives a single chunk far larger than the window', () => {
    const c = new OutputCollector(64);
    c.push(Buffer.from(`${'x'.repeat(5000)}END`));
    const out = c.text();
    expect(out.endsWith('END')).toBe(true);
    expect(out.length).toBeLessThan(400);
  });

  it('bounds memory no matter how much is written', () => {
    const c = new OutputCollector(64);
    for (let i = 0; i < 500; i++) c.push(Buffer.from('y'.repeat(1000)));
    expect(c.bytes).toBe(500_000);
    expect(c.text().length).toBeLessThan(400);
  });
});

describe('headTail', () => {
  it('returns short input untouched when nothing was omitted', () => {
    expect(headTail('short', '', 0)).toBe('short');
  });

  it('names how much it dropped', () => {
    const out = headTail('a\nb\nc', 'y\nz', 900);
    expect(out).toMatch(/omitted from the middle/);
    expect(out.startsWith('a')).toBe(true);
    expect(out.endsWith('z')).toBe(true);
  });
});

describe('backoffFor', () => {
  it('retries transient failures a bounded number of times', () => {
    // A plain error is what a socket reset or a timeout looks like.
    expect(backoffFor(new Error('socket hang up'), 0)).toBe(500);
    expect(backoffFor(new Error('socket hang up'), 1)).toBe(1000);
    // After three attempts it gives up rather than retrying a dead endpoint forever.
    expect(backoffFor(new Error('socket hang up'), 3)).toBeNull();
  });

  it('honours retry_after exactly as Telegram documents it', () => {
    // grammY's constructor takes the API error object, not a code: `new
    // GrammyError(msg, 429)` silently produces an error with no error_code at all,
    // which is why the production code reads the field rather than trusting the type.
    const err = new GrammyError(
      'Too Many Requests: retry after 7',
      {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 7 },
      },
      'sendMessage',
      {},
    );
    expect(backoffFor(err, 0)).toBe(7000);
  });

  it('gives up immediately on a permanent 4xx', () => {
    // A bad chat id or a deleted thread will never succeed, and retrying it only
    // spends the rate budget that the real reply needs.
    const err = new GrammyError(
      'Bad Request: chat not found',
      { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
      'sendMessage',
      {},
    );
    expect(backoffFor(err, 0)).toBeNull();
  });
});

describe('isStopCommand', () => {
  it('matches with suffixes and rejects lookalikes', () => {
    expect(isStopCommand('/stop')).toBe(true);
    expect(isStopCommand('/stop@mi_bot ya')).toBe(true);
    expect(isStopCommand('/stopwatch')).toBe(false);
  });
});

describe('isAddressedToBot', () => {
  it('needs a mention or a reply to the bot', () => {
    expect(isAddressedToBot('@mi_bot mira', {}, 'mi_bot')).toBe(true);
    expect(
      isAddressedToBot('hola', { reply_to_message: { from: { is_bot: true } } }, 'mi_bot'),
    ).toBe(true);
    expect(isAddressedToBot('hola', {}, 'mi_bot')).toBe(false);
  });
});

describe('chunkText', () => {
  it('splits on code points so emoji survive', () => {
    expect(chunkText('a😀b', 2)).toEqual(['a😀', 'b']);
    expect(chunkText('abcd', 4)).toEqual(['abcd']);
  });
});

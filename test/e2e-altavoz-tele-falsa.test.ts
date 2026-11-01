import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAltavozPlayer } from '../src/audio/altavoz.js';
import { tvCasterFromVault, tvStopperFromVault } from '../src/audio/tv-cast.js';
import { tvRequest } from '../src/tv/lgtv.js';
import { type FakeTvOptions, FakeWebOsTv } from './helpers/fake-webos-tv.js';

/**
 * Altavoz de punta a punta con la tele FALSA: nota de voz → servidor LAN real →
 * cliente SSAP real (registro con la client-key del vault) → la tele falsa abre la URL
 * y descarga el audio → /stop la para. Sin red real, sin tele real, sin daemon.
 */
const NOTE = Buffer.from('ID3-nota-de-voz-falsa');
const KEY = 'telegram:dm:42';
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout esperando a la tele falsa');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setup(handlers: NonNullable<FakeTvOptions['handlers']> = {}) {
  const downloads: Buffer[] = [];
  const download = (payload: Record<string, unknown>) => {
    // La tele "descarga" lo que le mandan abrir, como haría la de verdad.
    void fetch(String(payload.target))
      .then(async (res) => downloads.push(Buffer.from(await res.arrayBuffer())))
      .catch(() => {});
  };
  const tv = new FakeWebOsTv({
    handlers: {
      'media.viewer/open': (p) => {
        download(p);
        return { returnValue: true };
      },
      'media.controls/stop': () => ({ returnValue: true }),
      ...handlers,
    },
  });
  // El modo «descarga» también para el navegador de la tele.
  const launcherOpen = handlers['system.launcher/open'];
  if (launcherOpen) {
    tv.opts.handlers['system.launcher/open'] = (p) => {
      download(p);
      return launcherOpen(p);
    };
  }
  const vault: Record<string, string> = {
    'tv:host': '127.0.0.1',
    'tv:clientKey': 'KEY123',
    'tv:secure': '0',
  };
  const vaultGet = async (k: string) => vault[k];
  const request: Parameters<typeof tvCasterFromVault>[1] = (host, clientKey, uri, payload, d) =>
    tvRequest(host, clientKey, uri, payload, {
      ...d,
      factory: tv.factory,
      allowNonLanHost: true,
      commandTimeoutMs: 2_000,
    });
  const errors: unknown[] = [];
  const player = createAltavozPlayer({
    toPlayable: async (bytes) => {
      const d = mkdtempSync(join(tmpdir(), 'e2e-alt-tv-'));
      dirs.push(d);
      const f = join(d, 'nota.mp3');
      writeFileSync(f, bytes);
      return f;
    },
    playOnPc: async () => {
      throw new Error('no debería sonar en el PC');
    },
    castToTv: tvCasterFromVault(vaultGet, request, {
      pickAddress: () => '127.0.0.1',
      ttlMs: 5_000,
    }),
    stopTv: tvStopperFromVault(vaultGet, request),
    remove: (f) => rmSync(f, { force: true }),
    onError: (err) => errors.push(err),
  });
  const note = async () => ({ bytes: NOTE, mimeType: 'audio/ogg' });
  const uris = () => tv.requests.map((r) => r.uri);
  return { tv, player, note, downloads, errors, uris };
}

describe('e2e altavoz con la tele falsa', () => {
  it('la nota llega a la tele (visor), la descarga entera y /stop la para', async () => {
    const { tv, player, note, downloads, errors, uris } = setup();
    let failed: unknown;
    player.enqueue(
      'tele',
      note,
      (err) => {
        failed = err;
      },
      KEY,
    );
    await player.idle();
    expect(failed).toBeUndefined();
    expect(tv.registers).toContain('KEY123');
    expect(uris()).toContain('media.viewer/open');
    await until(() => downloads.length > 0);
    expect(downloads[0]?.equals(NOTE)).toBe(true);

    expect(player.clear(KEY)).toBe(1);
    await until(() => uris().includes('media.controls/stop'));
    expect(uris()).not.toContain('system.launcher/close');
    expect(errors).toEqual([]);
  });

  it('sin visor, la abre el navegador de la tele y /stop cierra ese navegador', async () => {
    const { player, note, downloads, errors, uris, tv } = setup({
      'media.viewer/open': () => {
        throw new Error('404 no such service or method');
      },
      'system.launcher/open': () => ({ returnValue: true, id: 'com.webos.app.browser' }),
      'com.webos.applicationManager/getForegroundAppInfo': () => ({
        returnValue: true,
        appId: 'com.webos.app.browser',
      }),
      'system.launcher/close': () => ({ returnValue: true }),
    });
    player.enqueue('tele', note, undefined, KEY);
    await player.idle();
    expect(uris()).toContain('system.launcher/open');
    await until(() => downloads.length > 0);

    expect(player.clear(KEY)).toBe(1);
    await until(() => uris().includes('system.launcher/close'));
    const close = tv.requests.find((r) => r.uri === 'system.launcher/close');
    expect(close?.payload).toEqual({ id: 'com.webos.app.browser' });
    expect(errors).toEqual([]);
  });

  it('el /stop de otro chat no toca la tele', async () => {
    const { player, note, uris } = setup();
    player.enqueue('tele', note, undefined, KEY);
    await player.idle();
    expect(player.clear('telegram:dm:99')).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(uris()).not.toContain('media.controls/stop');
  });
});

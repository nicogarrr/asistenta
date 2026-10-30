import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Nota de voz → tele → /stop por el núcleo del daemon (helpers/e2e-core): el arranque
 * REAL de onMessage (beginInbound) y el turno por la cola del hilo con modelo falso, el
 * enrutado REAL al altavoz (routeInboundToAltavoz + createAltavozPlayer), el cast REAL
 * (servidor LAN + cliente SSAP) contra la tele FALSA, y /stop por la tabla de comandos
 * REAL (buildCommandTable/dispatchCommand + parseCommand). Sin red, tele ni daemon reales.
 */
const root = mkdtempSync(join(tmpdir(), 'pa-e2e-altavoz-core-'));
process.env.PA_STATE_DIR = join(root, 'state');
process.env.PA_VAULT_BACKEND = 'portable';
process.env.PA_SECRET_PROVIDER_APIKEY = 'test-key-never-used';
process.env.PA_API_KEY = 'test-key-never-used';

vi.mock('../src/core/provider.js', () => ({
  createProviderHandle: async () =>
    (globalThis as unknown as { __e2eProvider?: { handle: unknown } }).__e2eProvider?.handle,
}));
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { Core, ScriptedModel, say, CHAT_ID, chatKey } = await import('./helpers/e2e-core.js');
const { FakeWebOsTv } = await import('./helpers/fake-webos-tv.js');
const { createAltavozPlayer, stopReplyText } = await import('../src/audio/altavoz.js');
const { routeInboundToAltavoz } = await import('../src/audio/altavoz-inbound.js');
const { tvCasterFromVault, tvStopperFromVault } = await import('../src/audio/tv-cast.js');
const { tvRequest } = await import('../src/tv/lgtv.js');
const { buildCommandTable, dispatchCommand } = await import('../src/daemon/commands.js');
const { parseCommand } = await import('../src/cli.js');
type InboundT = import('../src/channels/types.js').Inbound;

const NOTE = Buffer.from('ID3-nota-de-voz-del-nucleo');
const OWNER = Number(CHAT_ID);
const cores: InstanceType<typeof Core>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const c of cores.splice(0)) c.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout esperando a la tele falsa');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let seq = 0;
const msg = (text: string, extra: Partial<InboundT> = {}): InboundT =>
  ({
    channel: 'telegram',
    account: 'fake',
    chatId: CHAT_ID,
    userId: CHAT_ID,
    displayName: 'Nico',
    text,
    messageId: String(++seq),
    authorised: true,
    ...extra,
  }) as InboundT;

function daemon(name: string, now: () => number = Date.now) {
  const core = new Core(join(root, name)).start();
  cores.push(core);
  const downloads: Buffer[] = [];
  const tv = new FakeWebOsTv({
    handlers: {
      'media.viewer/open': (p) => {
        void fetch(String(p.target))
          .then(async (res) => downloads.push(Buffer.from(await res.arrayBuffer())))
          .catch(() => {});
        return { returnValue: true };
      },
      'media.controls/stop': () => ({ returnValue: true }),
    },
  });
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
      const d = mkdtempSync(join(tmpdir(), 'e2e-alt-core-'));
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
    now,
    remove: (f) => rmSync(f, { force: true }),
    onError: (err) => errors.push(err),
  });
  const replies: string[] = [];
  const table = buildCommandTable<InboundT>([
    {
      // Como cmdStop de cli.ts: la nota que suena (PC o tele reciente) se corta.
      names: ['stop'],
      run: async (m) => {
        const notes = player.clear(chatKey(m.chatId));
        replies.push(stopReplyText(0, notes));
      },
    },
  ]);
  // El orden de onMessage en cli.ts: altavoz primero (sin esperar al modelo), luego
  // comando o turno.
  const handle = async (m: InboundT) => {
    routeInboundToAltavoz(m, {
      mode: 'tele',
      desktop: true,
      ownerUserId: OWNER,
      player,
      download: async () => NOTE,
      reply: (text) => replies.push(text),
      key: chatKey(m.chatId),
    });
    const command = parseCommand(m.text);
    if (command) return dispatchCommand(table, m, command, async () => {});
    return core.deliver(m);
  };
  const uris = () => tv.requests.map((r) => r.uri);
  return { core, tv, player, handle, downloads, errors, replies, uris };
}

describe('e2e núcleo: nota de voz → tele → /stop', () => {
  it('la nota suena en la tele (bytes exactos), el turno contesta y /stop la para', async () => {
    const d = daemon('a');
    const model = new ScriptedModel();
    model.script(say('Te escucho.'));
    const r = await d.handle(msg('', { audioFileId: 'F1', audioMimeType: 'audio/ogg' }));
    expect((r as { text?: string } | undefined)?.text).toContain('Te escucho.');
    expect(d.core.receivedAudio).toEqual([expect.objectContaining({ fileId: 'F1' })]);
    await d.player.idle();
    expect(d.tv.registers).toContain('KEY123');
    expect(d.uris()).toContain('media.viewer/open');
    await until(() => d.downloads.length > 0);
    expect(d.downloads[0]?.equals(NOTE)).toBe(true);

    await d.handle(msg('/stop'));
    expect(d.replies.at(-1)).toBe(stopReplyText(0, 1));
    await until(() => d.uris().includes('media.controls/stop'));
    expect(d.uris()).not.toContain('system.launcher/close');
    expect(d.errors).toEqual([]);
  });

  it('/stop desde OTRO chat no toca la tele', async () => {
    const d = daemon('b');
    const model = new ScriptedModel();
    model.script(say('Vale.'));
    await d.handle(msg('', { audioFileId: 'F2', audioMimeType: 'audio/ogg' }));
    await d.player.idle();
    await until(() => d.downloads.length > 0);
    await d.handle(msg('/stop', { chatId: '-1009', userId: CHAT_ID }));
    expect(d.replies.at(-1)).toBe('No había nada en curso.');
    await new Promise((r) => setTimeout(r, 100));
    expect(d.uris()).not.toContain('media.controls/stop');
  });

  it('pasados 2 min /stop ya no toca la tele (puede estar con otra cosa)', async () => {
    let t = 1_000_000;
    const d = daemon('c', () => t);
    const model = new ScriptedModel();
    model.script(say('Vale.'));
    await d.handle(msg('', { audioFileId: 'F3', audioMimeType: 'audio/ogg' }));
    await d.player.idle();
    await until(() => d.downloads.length > 0);
    t += 120_001;
    await d.handle(msg('/stop'));
    expect(d.replies.at(-1)).toBe('No había nada en curso.');
    await new Promise((r) => setTimeout(r, 100));
    expect(d.uris()).not.toContain('media.controls/stop');
  });
});

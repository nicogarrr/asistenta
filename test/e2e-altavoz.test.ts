import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALTAVOZ_MAX_QUEUE,
  AltavozStore,
  createAltavozPlayer,
  parseAltavozArgs,
  stopReplyText,
} from '../src/audio/altavoz.js';
import { type AltavozInbound, routeInboundToAltavoz } from '../src/audio/altavoz-inbound.js';
import { TV_FIREWALL_HINT } from '../src/audio/tv-cast.js';

/**
 * Escenario completo del altavoz (/altavoz pc|tele, nota de voz, /stop) con un PC y
 * una tele falsos: lo que el daemon hace con cada nota entrante, sin Telegram real.
 */
const OWNER = 424242;
const ownerKey = `telegram:dm:${OWNER}`;
const voice = (over: Partial<AltavozInbound> = {}): AltavozInbound => ({
  channel: 'telegram',
  chatId: String(OWNER),
  userId: String(OWNER),
  text: '',
  audioFileId: 'voz-1',
  audioMimeType: 'audio/ogg',
  ...over,
});

let dir: string;
let store: AltavozStore;
let played: string[];
let cast: string[];
let downloads: string[];
let replies: string[];
let tvHits: number;
let pcGate: Promise<void> | null;

function setup(opts: { tele?: boolean } = {}) {
  const player = createAltavozPlayer({
    toPlayable: async (bytes) => `/tmp/${bytes.toString()}.mp3`,
    playOnPc: async (file, signal) => {
      played.push(file);
      if (pcGate) {
        await Promise.race([
          pcGate,
          new Promise<void>((res) => signal?.addEventListener('abort', () => res())),
        ]);
      }
    },
    castToTv: opts.tele
      ? async (file) => {
          cast.push(file);
          return { ok: true, message: 'ok', hits: () => tvHits };
        }
      : undefined,
    remove: () => {},
    noFetchMs: 1_000,
  });
  const deliver = (inbound: AltavozInbound, desktop = true) =>
    routeInboundToAltavoz(inbound, {
      mode: store.get(`telegram:dm:${inbound.chatId}`),
      desktop,
      ownerUserId: OWNER,
      player,
      download: async (id) => {
        downloads.push(id);
        return id === 'roto' ? null : Buffer.from(id);
      },
      reply: (text) => replies.push(text),
      key: `telegram:dm:${inbound.chatId}`,
    });
  return { player, deliver };
}

const altavoz = (chat: string, args: string) => {
  const parsed = parseAltavozArgs(args);
  if (parsed.kind === 'set') store.set(chat, parsed.mode);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-e2e-altavoz-'));
  store = new AltavozStore(join(dir, 'altavoz.json'));
  played = [];
  cast = [];
  downloads = [];
  replies = [];
  tvHits = 0;
  pcGate = null;
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('e2e altavoz', () => {
  it('/altavoz pc y una nota del dueño en privado suena en el PC sin contestar nada', async () => {
    const { player, deliver } = setup();
    altavoz(ownerKey, 'pc');
    expect(deliver(voice())).toBe('queued');
    await player.idle();
    expect(played).toEqual(['/tmp/voz-1.mp3']);
    expect(replies).toEqual([]);
  });

  it('el modo sobrevive a un reinicio (se lee del fichero)', async () => {
    altavoz(ownerKey, 'pc');
    store = new AltavozStore(join(dir, 'altavoz.json'));
    const { player, deliver } = setup();
    expect(deliver(voice())).toBe('queued');
    await player.idle();
    expect(played).toHaveLength(1);
  });

  it('en un chat que no es el privado del dueño no suena nada ni se descarga', async () => {
    const { player, deliver } = setup();
    altavoz(ownerKey, 'pc');
    altavoz('telegram:dm:-100777', 'pc');
    altavoz('telegram:dm:555', 'pc');
    // Grupo con el dueño hablando, otro usuario en su privado, y otro canal.
    expect(deliver(voice({ chatId: '-100777' }))).toBe('skipped');
    expect(deliver(voice({ chatId: '555', userId: '555' }))).toBe('skipped');
    expect(deliver(voice({ channel: 'qa' }))).toBe('skipped');
    await player.idle();
    expect(played).toEqual([]);
    expect(downloads).toEqual([]);
    expect(replies).toEqual([]);
  });

  it('apagado, sin escritorio o con un comando adjunto no suena', async () => {
    const { player, deliver } = setup();
    expect(deliver(voice())).toBe('skipped');
    altavoz(ownerKey, 'pc');
    altavoz(ownerKey, 'off');
    expect(deliver(voice())).toBe('skipped');
    altavoz(ownerKey, 'pc');
    expect(deliver(voice(), false)).toBe('skipped');
    expect(deliver(voice({ text: '/transcribe' }))).toBe('skipped');
    expect(deliver(voice({ audioFileId: undefined, text: 'hola' }))).toBe('skipped');
    await player.idle();
    expect(played).toEqual([]);
  });

  it('/stop corta la nota que suena y vacía la cola de ese chat, sin aviso de fallo', async () => {
    let release: () => void = () => {};
    pcGate = new Promise((r) => {
      release = r;
    });
    const { player, deliver } = setup();
    altavoz(ownerKey, 'pc');
    deliver(voice({ audioFileId: 'a' }));
    deliver(voice({ audioFileId: 'b' }));
    await vi.waitFor(() => expect(played).toEqual(['/tmp/a.mp3']));
    const stopped = player.clear(ownerKey);
    expect(stopReplyText(0, stopped)).toBe('Detenido. 2 nota(s) de voz paradas en el altavoz.');
    await player.idle();
    release();
    expect(played).toEqual(['/tmp/a.mp3']);
    expect(replies).toEqual([]);
  });

  it('una nota que no se puede descargar avisa en el chat', async () => {
    const { player, deliver } = setup();
    altavoz(ownerKey, 'pc');
    deliver(voice({ audioFileId: 'roto' }));
    await player.idle();
    expect(played).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/^🔇 No he podido soltarla en el altavoz:/);
  });

  it('con la cola llena la nota nueva no se suelta y se avisa', async () => {
    pcGate = new Promise(() => {});
    const { player, deliver } = setup();
    altavoz(ownerKey, 'pc');
    for (let i = 0; i < ALTAVOZ_MAX_QUEUE; i++) {
      expect(deliver(voice({ audioFileId: `n${i}` }))).toBe('queued');
    }
    expect(deliver(voice({ audioFileId: 'extra' }))).toBe('full');
    expect(replies).toEqual(['Hay demasiadas notas en cola en el altavoz; esta no la suelto.']);
    player.clear();
    await player.idle();
  });

  it('/altavoz tele sin la tele activada avisa de que falta PA_AUDIO_TELE', async () => {
    const { player, deliver } = setup();
    altavoz(ownerKey, 'tele');
    deliver(voice());
    await player.idle();
    expect(replies[0]).toContain('PA_AUDIO_TELE=1');
  });

  it('/altavoz tele: si la tele nunca descarga el fichero avisa del firewall una vez', async () => {
    vi.useFakeTimers();
    const { player, deliver } = setup({ tele: true });
    altavoz(ownerKey, 'tele');
    deliver(voice({ audioFileId: 'a' }));
    await player.idle();
    expect(cast).toEqual(['/tmp/a.mp3']);
    expect(played).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    deliver(voice({ audioFileId: 'b' }));
    await player.idle();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(replies).toEqual([`📺 ${TV_FIREWALL_HINT}`]);
  });

  it('/altavoz tele: si la tele lo descarga no hay aviso', async () => {
    vi.useFakeTimers();
    tvHits = 1;
    const { player, deliver } = setup({ tele: true });
    altavoz(ownerKey, 'tele');
    deliver(voice());
    await player.idle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(replies).toEqual([]);
  });
});

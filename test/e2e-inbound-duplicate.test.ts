import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Update de Telegram repetido, de punta a punta: el arnés pasa por el arranque REAL
 * de onMessage (beginInbound) y la cola real del hilo. Telegram entrega al menos una
 * vez; el mismo update dos veces no puede lanzar dos turnos.
 */
const root = mkdtempSync(join(tmpdir(), 'pa-e2e-dup-'));
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

const { Core, ScriptedModel, say, CHAT_ID } = await import('./helpers/e2e-core.js');
type InboundT = import('../src/channels/types.js').Inbound;

const cores: InstanceType<typeof Core>[] = [];
afterEach(() => {
  for (const c of cores.splice(0)) c.stop();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const msg = (messageId: string, text: string, extra: Partial<InboundT> = {}): InboundT =>
  ({
    channel: 'telegram',
    account: 'bot',
    chatId: CHAT_ID,
    userId: '1',
    displayName: 'Nico',
    text,
    messageId,
    authorised: true,
    ...extra,
  }) as InboundT;

describe('e2e: update repetido', () => {
  it('el mismo update dos veces lanza UN turno; otro id sí lanza el suyo', async () => {
    const core = new Core(join(root, 'a')).start();
    cores.push(core);
    const model = new ScriptedModel();
    model.script(say('Primera respuesta.'));
    const first = await core.deliver(msg('100', 'hola'));
    expect(first?.text).toContain('Primera respuesta.');
    const again = await core.deliver(msg('100', 'hola'));
    expect(again).toBeUndefined();
    expect(model.contexts).toHaveLength(1);

    model.script(say('Segunda respuesta.'));
    const next = await core.deliver(msg('101', 'hola otra vez'));
    expect(next?.text).toContain('Segunda respuesta.');
    expect(model.contexts).toHaveLength(2);
    // El disparador 'mensaje' tampoco se duplica.
    expect(core.messageTriggers.map((t) => t.text)).toEqual(['hola', 'hola otra vez']);
  });

  it('un comando no dispara «mensaje»; el audio queda registrado y el último chat apuntado', async () => {
    const core = new Core(join(root, 'b')).start();
    cores.push(core);
    const model = new ScriptedModel();
    model.script(say('Vale.'));
    await core.deliver(msg('200', 'esto suena', { audioFileId: 'f1', threadId: '7' }));
    expect(core.receivedAudio).toEqual([expect.objectContaining({ fileId: 'f1' })]);
    expect(core.lastChat).toMatchObject({ chatId: CHAT_ID, threadId: '7' });
    expect(core.messageTriggers).toHaveLength(1);
  });
});

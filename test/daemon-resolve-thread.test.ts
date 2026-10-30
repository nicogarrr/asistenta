import { describe, expect, it, vi } from 'vitest';
import type { Inbound } from '../src/channels/types.js';
import { cachedFullReply, resolveInboundThread } from '../src/daemon/inbound.js';
import { splitGoalScope } from '../src/goals/store.js';

type T = { key: string; active: boolean };
const CK = 'telegram:bot:42';
const inb = (over: Partial<Inbound> = {}): Inbound =>
  ({
    channel: 'telegram',
    account: 'bot',
    chatId: '42',
    userId: '1',
    text: 'hola',
    messageId: '9',
    ...over,
  }) as Inbound;

function deps(mainActive = false) {
  const threads = new Map<string, T>();
  const main: T = { key: `${CK}#main`, active: mainActive };
  const getOrCreateThread = vi.fn(async (chatKey: string, name: string, label: string) => ({
    key: `${chatKey}#${name}`,
    active: false,
    label,
  }));
  return {
    activeTopic: new Map<string, string>(),
    messageThread: new Map<string, string>(),
    threads,
    goalScopeBySentId: vi.fn((): string | null => null),
    splitGoalScope,
    getOrCreateThread,
    defaultThread: vi.fn(async () => main),
    looksLikeFollowUp: vi.fn(() => false),
    main,
  };
}

describe('resolveInboundThread', () => {
  it('/topic activo gana a todo', async () => {
    const d = deps(true);
    d.activeTopic.set(CK, 'viaje');
    await resolveInboundThread(inb({ replyToMessageId: '1', threadId: '5' }), CK, d);
    expect(d.getOrCreateThread).toHaveBeenCalledWith(CK, 'viaje', 'viaje');
  });

  it('respuesta a un mensaje de un hilo vivo → ese hilo', async () => {
    const d = deps(true);
    const t = { key: `${CK}#m3`, active: true };
    d.threads.set(t.key, t);
    d.messageThread.set(`${CK}:77`, t.key);
    expect(await resolveInboundThread(inb({ replyToMessageId: '77' }), CK, d)).toBe(t);
    expect(d.goalScopeBySentId).not.toHaveBeenCalled();
  });

  it('tras un reinicio, respuesta al aviso de un objetivo de este chat → su hilo, y queda apuntado', async () => {
    const d = deps(true);
    d.goalScopeBySentId.mockReturnValue(`${CK}#main`);
    await resolveInboundThread(inb({ replyToMessageId: '88' }), CK, d);
    expect(d.getOrCreateThread).toHaveBeenCalledWith(CK, 'main', 'principal');
    expect(d.messageThread.get(`${CK}:88`)).toBe(`${CK}#main`);
  });

  it('el aviso de un objetivo de OTRO chat no se usa', async () => {
    const d = deps(false);
    d.goalScopeBySentId.mockReturnValue('telegram:bot:99#main');
    expect(await resolveInboundThread(inb({ replyToMessageId: '88' }), CK, d)).toBe(d.main);
    expect(d.messageThread.size).toBe(0);
  });

  it('tema del foro → hilo t<id>', async () => {
    const d = deps(true);
    await resolveInboundThread(inb({ threadId: '5' }), CK, d);
    expect(d.getOrCreateThread).toHaveBeenCalledWith(CK, 't5', 'hilo 5');
  });

  it('principal libre, o ocupado pero el texto sigue la conversación → principal', async () => {
    const free = deps(false);
    expect(await resolveInboundThread(inb(), CK, free)).toBe(free.main);
    const busy = deps(true);
    busy.looksLikeFollowUp.mockReturnValue(true);
    expect(await resolveInboundThread(inb(), CK, busy)).toBe(busy.main);
  });

  it('principal ocupado y petición nueva → hilo m<id> con el texto recortado (o «petición»)', async () => {
    const d = deps(true);
    await resolveInboundThread(inb({ text: `  ${'x'.repeat(60)}  ` }), CK, d);
    await resolveInboundThread(inb({ text: '   ', messageId: '10' }), CK, d);
    expect(d.getOrCreateThread.mock.calls).toEqual([
      [CK, 'm9', 'x'.repeat(40)],
      [CK, 'm10', 'petición'],
    ]);
  });
});

describe('cachedFullReply', () => {
  const more = (full: string | null) => ({
    isMoreRequest: (t: string) => /^(dime m[aá]s|sigue)$/i.test(t),
    takeFullReply: vi.fn(() => full),
  });
  it('«dime más» sirve lo guardado del hilo', () => {
    const m = more('texto completo');
    expect(cachedFullReply({ text: 'dime más' }, 'k', m)).toBe('texto completo');
    expect(m.takeFullReply).toHaveBeenCalledWith('k');
  });
  it('con fotos, o si no es «dime más», no toca la caché', () => {
    const m = more('x');
    expect(cachedFullReply({ text: 'sigue', images: [{}] as never }, 'k', m)).toBeUndefined();
    expect(cachedFullReply({ text: 'otra cosa' }, 'k', m)).toBeUndefined();
    expect(m.takeFullReply).not.toHaveBeenCalled();
  });
});

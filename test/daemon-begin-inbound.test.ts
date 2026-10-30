import { describe, expect, it, vi } from 'vitest';
import type { Inbound } from '../src/channels/types.js';
import { beginInbound, isMailReplyRequest } from '../src/daemon/inbound.js';

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

function deps() {
  return {
    seen: new Map<string, number>(),
    log: { info: vi.fn(), warn: vi.fn() },
    emitMessageTrigger: vi.fn(async () => {}),
    setLastChat: vi.fn(),
    recordAudio: vi.fn(),
  };
}

describe('beginInbound', () => {
  it('primer update: devuelve la clave, dispara «mensaje» y apunta el último chat', () => {
    const d = deps();
    expect(beginInbound(inb({ threadId: '3' }), 'tg:bot:42', d)).toEqual({
      dedupKey: 'tg:bot:42:9',
    });
    expect(d.emitMessageTrigger).toHaveBeenCalledWith('tg:bot:42', 'hola');
    expect(d.setLastChat).toHaveBeenCalledWith({ key: 'tg:bot:42', chatId: '42', threadId: '3' });
    expect(d.recordAudio).not.toHaveBeenCalled();
  });

  it('update repetido: null y nada más (ni disparador, ni último chat, ni audio)', () => {
    const d = deps();
    beginInbound(inb({ audioFileId: 'a' }), 'k', d);
    vi.clearAllMocks();
    expect(beginInbound(inb({ audioFileId: 'a' }), 'k', d)).toBeNull();
    expect(d.emitMessageTrigger).not.toHaveBeenCalled();
    expect(d.setLastChat).not.toHaveBeenCalled();
    expect(d.recordAudio).not.toHaveBeenCalled();
    expect(d.log.info).toHaveBeenCalledWith('duplicate update ignored', { messageId: '9' });
  });

  it('un comando o un mensaje sin texto no dispara «mensaje»', () => {
    const d = deps();
    beginInbound(inb({ text: '/estado', messageId: '1' }), 'k', d);
    beginInbound(inb({ text: '', messageId: '2' }), 'k', d);
    expect(d.emitMessageTrigger).not.toHaveBeenCalled();
    expect(d.setLastChat).toHaveBeenCalledTimes(2);
  });

  it('audio: se registra con ogg por defecto y el pie como caption (vacío → sin caption)', () => {
    const d = deps();
    beginInbound(inb({ audioFileId: 'f', text: '  /play ', audioDurationSeconds: 4 }), 'k', d);
    beginInbound(
      inb({ audioFileId: 'g', text: '', messageId: '10', audioMimeType: 'audio/mpeg' }),
      'k',
      d,
    );
    expect(d.recordAudio.mock.calls).toEqual([
      [
        'k',
        {
          fileId: 'f',
          mimeType: 'audio/ogg',
          messageId: '9',
          durationSeconds: 4,
          caption: '/play',
        },
      ],
      [
        'k',
        {
          fileId: 'g',
          mimeType: 'audio/mpeg',
          messageId: '10',
          durationSeconds: undefined,
          caption: undefined,
        },
      ],
    ]);
  });

  it('un disparador que falla solo deja un aviso en el log', async () => {
    const d = deps();
    d.emitMessageTrigger.mockRejectedValueOnce(new Error('roto'));
    expect(beginInbound(inb(), 'k', d)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.log.warn).toHaveBeenCalledWith('trigger mensaje falló', { err: 'Error: roto' });
  });
});

describe('isMailReplyRequest', () => {
  it('«responde a ese» / «responder a ese» seguido de salto de línea', () => {
    expect(isMailReplyRequest('responde a ese\nVale, nos vemos')).toBe(true);
    expect(isMailReplyRequest('Responder a ese  \ntexto')).toBe(true);
    expect(isMailReplyRequest('responde a ese')).toBe(false);
    expect(isMailReplyRequest('oye, responde a ese\nx')).toBe(false);
  });
});

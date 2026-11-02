import { describe, expect, it } from 'vitest';
import type { Inbound } from '../src/channels/types.js';
import {
  BATCH_HEADER,
  canJoinMessageBatch,
  isBatchableInbound,
  mergeBatchedInbounds,
  queueMessageTurn,
  queueThreadTurn,
} from '../src/daemon/inbound.js';

// Mensajes en ráfaga (#1835), afinado: cada mensaje va separado y con su cita, lo de
// terceros sigue marcado, nunca se mezclan personas y no se pierden audios ni documentos.

const msg = (over: Partial<Inbound> = {}): Inbound =>
  ({
    channel: 'telegram',
    account: 'bot',
    chatId: '42',
    userId: '1',
    text: 'hola',
    messageId: '1',
    authorised: true,
    receivedAt: '2026-11-02T10:02:00.000Z',
    ...over,
  }) as Inbound;

const time = (iso: string) => iso.slice(11, 16);

function busyThread() {
  const t = { tail: Promise.resolve() as Promise<unknown>, generation: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const p = queueThreadTurn(t, () => gate);
  return { t, p, release };
}

describe('mergeBatchedInbounds', () => {
  it('cada mensaje separado, numerado y con su hora; se contesta citando al último', () => {
    const out = mergeBatchedInbounds(
      [
        msg({ text: 'reserva para el jueves', messageId: '10' }),
        msg({
          text: 'mejor el viernes',
          messageId: '11',
          receivedAt: '2026-11-02T10:03:00.000Z',
        }),
      ],
      { linked: () => false, time },
    );
    expect(out.messageId).toBe('11');
    expect(out.text).toBe(
      [
        BATCH_HEADER,
        '[Mensaje 1 de 2 · 10:02]\nreserva para el jueves',
        '[Mensaje 2 de 2 · 10:03]\nmejor el viernes',
      ].join('\n\n'),
    );
  });

  it('un reenvío sigue marcado y lo que escribe después el dueño va en otra pieza', () => {
    const out = mergeBatchedInbounds(
      [
        msg({
          text: '[Mensaje reenviado de Ana]\n¿quedamos el jueves?',
          forwardedFrom: '[Mensaje reenviado de Ana]',
        }),
        msg({ text: 'dile que sí', messageId: '2' }),
      ],
      { linked: () => false, time },
    );
    expect(out.text).toContain(
      '[Mensaje 1 de 2 · 10:02]\n[Mensaje reenviado de Ana]\n¿quedamos el jueves?',
    );
    expect(out.text).toContain('[Mensaje 2 de 2 · 10:02]\ndile que sí');
    expect(out.forwardedFrom).toBeUndefined();
  });

  it('la cita de cada mensaje va en su pieza (salvo si el hilo ya la tiene)', () => {
    const out = mergeBatchedInbounds(
      [
        msg({ text: '¿y esto?', replyToMessageId: '5', replyQuote: '[Respondes a: «factura»]' }),
        msg({ text: 'y esto otro', replyToMessageId: '6', replyQuote: '[Respondes a: «hilo»]' }),
      ],
      { linked: (m) => m.replyToMessageId === '6', time },
    );
    expect(out.text).toContain('[Respondes a: «factura»]\n¿y esto?');
    expect(out.text).not.toContain('«hilo»');
    expect(out.replyQuote).toBeUndefined();
  });

  it('uno solo sale tal cual', () => {
    const one = msg({ replyQuote: '[cita]' });
    expect(mergeBatchedInbounds([one], { linked: () => false, time })).toBe(one);
  });
});

describe('qué se puede fundir', () => {
  it('solo texto: audio, documento, fotos, álbumes y comandos van solos', () => {
    expect(isBatchableInbound(msg())).toBe(true);
    expect(isBatchableInbound(msg({ audioFileId: 'a' }))).toBe(false);
    expect(isBatchableInbound(msg({ documentFileId: 'd' }))).toBe(false);
    expect(isBatchableInbound(msg({ images: [{ type: 'image' } as never] }))).toBe(false);
    expect(isBatchableInbound(msg({ albumPhotoFileIds: ['p'] }))).toBe(false);
    expect(isBatchableInbound(msg({ text: '/estado' }))).toBe(false);
    expect(isBatchableInbound(msg({ text: '  ' }))).toBe(false);
  });

  it('en un grupo, dos personas no van en la misma tanda', () => {
    expect(canJoinMessageBatch([msg({ userId: '1' })], msg({ userId: '2' }))).toBe(false);
    expect(canJoinMessageBatch([msg({ userId: '1' })], msg({ userId: '1' }))).toBe(true);
  });
});

describe('queueMessageTurn con la regla de unión', () => {
  it('una nota de voz y un texto mientras trabaja: dos turnos, no se pierde el audio', async () => {
    const { t, p, release } = busyThread();
    const runs: Inbound[][] = [];
    const run = async (list: readonly Inbound[]) => {
      runs.push([...list]);
    };
    const a = queueMessageTurn(t, msg({ text: '', audioFileId: 'voz' }), run, canJoinMessageBatch);
    const b = queueMessageTurn(t, msg({ text: 'y apúntalo' }), run, canJoinMessageBatch);
    const c = queueMessageTurn(t, msg({ text: 'para mañana' }), run, canJoinMessageBatch);
    release();
    await Promise.all([p, a, b, c]);
    expect(runs.map((r) => r.map((m) => m.audioFileId ?? m.text))).toEqual([
      ['voz'],
      ['y apúntalo', 'para mañana'],
    ]);
  });

  it('mensajes de dos personas del grupo: cada una en su turno, en orden', async () => {
    const { t, p, release } = busyThread();
    const runs: string[][] = [];
    const run = async (list: readonly Inbound[]) => {
      runs.push(list.map((m) => `${m.userId}:${m.text}`));
    };
    const a = queueMessageTurn(t, msg({ userId: '1', text: 'a' }), run, canJoinMessageBatch);
    const b = queueMessageTurn(t, msg({ userId: '2', text: 'b' }), run, canJoinMessageBatch);
    const c = queueMessageTurn(t, msg({ userId: '2', text: 'c' }), run, canJoinMessageBatch);
    release();
    await Promise.all([p, a, b, c]);
    expect(runs).toEqual([['1:a'], ['2:b', '2:c']]);
  });

  it('el primer mensaje con el hilo libre no espera a nadie', async () => {
    const t = { tail: Promise.resolve() as Promise<unknown>, generation: 0 };
    const runs: string[][] = [];
    await queueMessageTurn(
      t,
      msg({ text: 'ya' }),
      async (list) => {
        runs.push(list.map((m) => m.text));
      },
      canJoinMessageBatch,
    );
    expect(runs).toEqual([['ya']]);
  });

  it('/stop (generación nueva) descarta la tanda', async () => {
    const { t, p, release } = busyThread();
    const runs: string[][] = [];
    const a = queueMessageTurn(
      t,
      msg({ text: 'x' }),
      async (list) => {
        runs.push(list.map((m) => m.text));
      },
      canJoinMessageBatch,
    );
    t.generation++;
    release();
    await Promise.all([p, a]);
    expect(runs).toEqual([]);
  });
});

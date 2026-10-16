import { describe, expect, it, vi } from 'vitest';
import {
  checkTelegramToken,
  startupFailureMessage,
  withInboundFailureReply,
} from '../src/startup.js';

describe('startup checks', () => {
  it('checks Telegram without a model request and accepts a confirmed bot', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: { id: 1 } })),
    );
    await checkTelegramToken('synthetic', fetcher as typeof fetch);
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it.each([401, 404])('rejects invalid token %s without exposing it', async (status) => {
    await expect(
      checkTelegramToken(
        'never-print-me',
        (async () => new Response('', { status })) as typeof fetch,
      ),
    ).rejects.toThrow('El token de Telegram no es válido');
  });
  it('distinguishes network failure and never prints a token-bearing URL', async () => {
    await expect(
      checkTelegramToken('never-print-me', (async () => {
        throw new Error('https://api.telegram.org/botnever-print-me');
      }) as typeof fetch),
    ).rejects.toThrow('No puedo conectar con Telegram');
  });
  it('rejects malformed or unconfirmed responses', async () => {
    for (const body of ['bad json', '{"ok":false}', 'null'])
      await expect(
        checkTelegramToken('synthetic', (async () => new Response(body)) as typeof fetch),
      ).rejects.toThrow('no confirmó');
  });
});

describe('inbound error boundary', () => {
  it('reports missing first-thread credentials with a useful Spanish reply', async () => {
    const reply = vi.fn(async (_message: string) => undefined);
    const report = vi.fn();
    await withInboundFailureReply(
      async () => {
        throw new Error('no API key: internal diagnostic');
      },
      reply,
      report,
    );
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[0]).toContain('Falta la clave');
    expect(report).toHaveBeenCalledOnce();
  });
  it('does not leak arbitrary error text in the reply', () => {
    expect(startupFailureMessage(new Error('SECRET=123 internal host'))).not.toContain('SECRET');
  });
  it('does not retry the task when sending the failure reply also fails', async () => {
    const handle = vi.fn(async () => {
      throw new Error('failed');
    });
    const report = vi.fn();
    await expect(
      withInboundFailureReply(
        handle,
        async () => {
          throw new Error('network down');
        },
        report,
      ),
    ).resolves.toBeUndefined();
    expect(handle).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledTimes(2);
  });
  it('preserves successful results without adding a message', async () => {
    const reply = vi.fn();
    expect(await withInboundFailureReply(async () => 42, reply, vi.fn())).toBe(42);
    expect(reply).not.toHaveBeenCalled();
  });
});

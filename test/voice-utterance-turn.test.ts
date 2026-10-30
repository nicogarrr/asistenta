import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Inbound } from '../src/channels/types.js';
import { VOICE_PREFIX, voiceUtteranceTurn } from '../src/daemon/voice-turn.js';

describe('voz como canal, paso 2: voiceUtteranceTurn', () => {
  const chat = { key: 'telegram:acc:42', chatId: '42', threadId: undefined };

  function harness() {
    const calls: string[] = [];
    let n = 6;
    let ran: { inbound: Inbound; text: string } | null = null;
    const deps = {
      account: 'acc',
      nextN: () => {
        calls.push('n');
        return ++n;
      },
      getThread: async (key: string) => {
        calls.push(`thread:${key}`);
        return { key: `${key}:main` };
      },
      linkMessage: (dedup: string, threadKey: string) => calls.push(`link:${dedup}->${threadKey}`),
      logUtterance: (f: { chars: number; chatId: string }) =>
        calls.push(`log:${f.chars}:${f.chatId}`),
      enqueue: async (t: { key: string }, work: () => Promise<void>) => {
        calls.push(`enqueue:${t.key}`);
        await work();
      },
      runTurn: async (
        _t: { key: string },
        inbound: Inbound,
        text: string,
        opts: { spoken: (a: string) => Promise<void> },
      ) => {
        calls.push('runTurn');
        ran = { inbound, text };
        await opts.spoken('respuesta');
      },
      speak: async (a: string) => {
        calls.push(`speak:${a}`);
      },
    };
    return { calls, deps, ran: () => ran };
  }

  it('numera, busca el hilo principal, enlaza el mensaje y corre el turno encolado', async () => {
    const h = harness();
    await voiceUtteranceTurn(chat, 'pon la tele', h.deps);
    expect(h.calls).toEqual([
      'n',
      'thread:telegram:acc:42',
      'link:telegram:acc:42:voz-7->telegram:acc:42:main',
      'log:11:42',
      'enqueue:telegram:acc:42:main',
      'runTurn',
      'speak:respuesta',
    ]);
  });

  it('el turno es un mensaje de Telegram del chat (aprobaciones con botones) con el prefijo de voz', async () => {
    const h = harness();
    await voiceUtteranceTurn(chat, 'hola', h.deps);
    const r = h.ran();
    expect(r?.inbound.channel).toBe('telegram');
    expect(r?.inbound.chatId).toBe('42');
    expect(r?.inbound.messageId).toBe('voz-7');
    expect(r?.text).toBe(`${VOICE_PREFIX} hola`);
    expect(r?.inbound.text).toBe(r?.text);
  });

  it('cli.ts delega onUtterance en voiceUtteranceTurn', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(
      /onUtterance: \(heard\)(: Promise<void>)? =>\s*voiceUtteranceTurn\(chat, heard, \{/,
    );
    expect(cli).not.toMatch(/voiceInbound\(telegram\.account/);
  });
});

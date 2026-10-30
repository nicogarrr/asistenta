import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { voiceInbound } from '../src/daemon/voice-turn.js';

describe('voz: lo dicho en voz alta entra como un Inbound más', () => {
  it('construye el mismo Inbound que antes (chat del propietario, marcado como dicho en voz alta)', () => {
    const at = new Date('2026-10-30T14:00:00Z');
    expect(
      voiceInbound('bot', { chatId: '42', threadId: undefined }, 'pon la tele', 3, at),
    ).toEqual({
      channel: 'telegram',
      account: 'bot',
      chatId: '42',
      threadId: undefined,
      userId: '42',
      displayName: 'conversación por voz',
      text: '[dicho en voz alta ante el microfono] pon la tele',
      authorised: true,
      messageId: 'voz-3',
      receivedAt: '2026-10-30T14:00:00.000Z',
    });
  });

  it('cli.ts no construye el Inbound de voz a mano (va por voiceUtteranceTurn → voiceInbound)', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(/voiceUtteranceTurn\(chat, heard, \{/);
    expect(cli).toMatch(/nextN: \(\) => \+\+wakeCount/);
    expect(cli).not.toMatch(/displayName: 'conversación por voz'/);
  });
});

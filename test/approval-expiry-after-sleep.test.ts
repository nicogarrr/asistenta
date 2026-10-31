import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelRegistry } from '../src/channels/registry.js';

afterEach(() => {
  vi.useRealTimers();
});

function ask(registry: ChannelRegistry, id: string, minutes: number): Promise<boolean> {
  return registry.requestApproval({
    id,
    origin: {
      channel: 'telegram',
      account: 'main',
      chatId: '1',
      userId: '2',
      text: '',
      authorised: true,
      messageId: '3',
      receivedAt: new Date().toISOString(),
    },
    tool: 'computer',
    reason: 'prueba',
    summary: 'abrir algo',
    expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
  });
}

describe('aprobación tras suspender el PC', () => {
  it('un «sí» pulsado después de caducar no vale aunque el temporizador no haya saltado', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 31, 1, 0));
    const registry = new ChannelRegistry();
    const p = ask(registry, 'a1', 5);
    // El PC duerme 2 horas: el reloj avanza, el temporizador no llega a saltar.
    vi.setSystemTime(Date.UTC(2026, 9, 31, 3, 0));
    expect(registry.pendingApprovals()).toHaveLength(0);
    expect(registry.resolveApproval('a1', true)).toBe(false);
    expect(await p).toBe(false);
  });

  it('dentro de plazo sigue funcionando', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 31, 1, 0));
    const registry = new ChannelRegistry();
    const p = ask(registry, 'a2', 5);
    vi.setSystemTime(Date.UTC(2026, 9, 31, 1, 4));
    expect(registry.pendingApprovals()).toHaveLength(1);
    expect(registry.resolveApproval('a2', true)).toBe(true);
    expect(await p).toBe(true);
  });

  it('un «no» tardío también cierra la petición', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 31, 1, 0));
    const registry = new ChannelRegistry();
    const p = ask(registry, 'a3', 5);
    vi.setSystemTime(Date.UTC(2026, 9, 31, 3, 0));
    registry.resolveApproval('a3', false);
    expect(await p).toBe(false);
  });
});

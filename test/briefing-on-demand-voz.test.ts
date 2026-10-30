import { describe, expect, it, vi } from 'vitest';
import type { DailyBriefingDeps } from '../src/briefing-daily.js';
import * as briefing from '../src/briefing-daily.js';

function deps(extra: Partial<DailyBriefingDeps>): DailyBriefingDeps {
  return {
    enabled: () => true,
    now: () => new Date(2026, 9, 30, 8, 5),
    lastSent: () => 0,
    markSent: vi.fn(),
    owner: () => '1',
    send: async () => true,
    ...extra,
  } as DailyBriefingDeps;
}

/** `/resumen hoy` con PA_BRIEFING_VOZ: antes solo hablaba el resumen automático. */
describe('/resumen hoy con voz', () => {
  it('manda el texto y después la nota de voz, sin tocar el ritmo diario', async () => {
    const order: string[] = [];
    const speak = vi.fn(async (chatId: string, text: string) => {
      order.push(`voz:${chatId}:${text.length > 0}`);
    });
    const d = deps({ speak });
    const answer = (briefing as Record<string, unknown>).answerBriefingOnDemand as
      | typeof briefing.answerBriefingOnDemand
      | undefined;
    expect(typeof answer).toBe('function');
    const text = await answer?.(d, '42', async (t) => {
      order.push(`texto:${t.length > 0}`);
    });
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['texto:true', 'voz:42:true']);
    expect(speak.mock.calls[0]?.[1]).toBe(text);
    expect(d.markSent).not.toHaveBeenCalled();
  });

  it('si el texto no sale, no hay voz; una voz lenta no retrasa la respuesta', async () => {
    const speak = vi.fn(() => new Promise<void>(() => {}));
    const d = deps({ speak });
    await expect(
      briefing.answerBriefingOnDemand(d, '42', async () => {
        throw new Error('telegram caído');
      }),
    ).rejects.toThrow('telegram caído');
    await new Promise((r) => setTimeout(r, 20));
    expect(speak).not.toHaveBeenCalled();

    const done = await Promise.race([
      briefing.answerBriefingOnDemand(d, '42', async () => {}).then(() => 'ok'),
      new Promise((r) => setTimeout(() => r('colgado'), 1000)),
    ]);
    expect(done).toBe('ok');
  });

  it('sin PA_BRIEFING_VOZ (sin speak) solo responde el texto', async () => {
    const reply = vi.fn(async () => {});
    await briefing.answerBriefingOnDemand(deps({}), '42', reply);
    expect(reply).toHaveBeenCalledTimes(1);
  });
});

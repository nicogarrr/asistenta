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

type Api = {
  stopBriefingVoice?: (chatId: string) => number;
  briefingSpeaker?: (opts: {
    synth: (text: string) => Promise<string | null>;
    send: (chatId: string, audio: string) => Promise<unknown>;
  }) => (chatId: string, text: string, signal?: AbortSignal) => Promise<void>;
};
const api = briefing as unknown as Api;

/** /stop mientras se sintetiza la nota de voz del resumen (PA_BRIEFING_VOZ). */
describe('/stop y la voz del resumen', () => {
  it('/stop durante la síntesis: la nota no sale', async () => {
    expect(typeof api.stopBriefingVoice).toBe('function');
    expect(typeof api.briefingSpeaker).toBe('function');
    let finish: (v: string) => void = () => {};
    const synth = vi.fn(
      () =>
        new Promise<string | null>((r) => {
          finish = r;
        }),
    );
    const send = vi.fn(async () => true);
    const speak = api.briefingSpeaker?.({ synth, send });
    await briefing.answerBriefingOnDemand(deps({ speak }), '42', async () => {});
    await vi.waitFor(() => expect(synth).toHaveBeenCalledTimes(1));
    expect(api.stopBriefingVoice?.('42')).toBe(1);
    finish('audio');
    await new Promise((r) => setTimeout(r, 10));
    expect(send).not.toHaveBeenCalled();
  });

  it('sin /stop la nota sale; un /stop de otro chat no la toca', async () => {
    let finish: (v: string) => void = () => {};
    const synth = vi.fn(
      () =>
        new Promise<string | null>((r) => {
          finish = r;
        }),
    );
    const send = vi.fn(async () => true);
    const speak = api.briefingSpeaker?.({ synth, send });
    await briefing.answerBriefingOnDemand(deps({ speak }), '42', async () => {});
    await vi.waitFor(() => expect(synth).toHaveBeenCalledTimes(1));
    expect(api.stopBriefingVoice?.('7')).toBe(0);
    finish('audio');
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('42', 'audio'));
  });

  it('el resumen automático de la mañana también se para con /stop', async () => {
    let finish: (v: string) => void = () => {};
    const synth = vi.fn(
      () =>
        new Promise<string | null>((r) => {
          finish = r;
        }),
    );
    const send = vi.fn(async () => true);
    const speak = api.briefingSpeaker?.({ synth, send });
    const d = deps({ speak, owner: () => '9', weather: async () => 'Sol, 20 °C' });
    const res = await briefing.runDailyBriefingIfDue(d);
    expect(res.status).toBe('sent');
    await vi.waitFor(() => expect(synth).toHaveBeenCalledTimes(1));
    expect(api.stopBriefingVoice?.('9')).toBe(1);
    finish('audio');
    await new Promise((r) => setTimeout(r, 10));
    expect(send).not.toHaveBeenCalled();
    // Ya terminada, un segundo /stop no cuenta nada.
    expect(api.stopBriefingVoice?.('9')).toBe(0);
  });
});

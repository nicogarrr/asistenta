/**
 * Los especialistas y subagentes de `delegate` no llevaban chat: sus marcas de «ocupada»
 * (turno del hijo, permiso que pide) quedaban sin dueño, y /stop en CUALQUIER chat las soltaba
 * 5 s después aunque el hijo siguiera trabajando para otro chat (#1929 solo cubría los hilos).
 * Ahora el hijo hereda el chat del hilo que delega y /stop de otro chat no lo toca.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { createDelegateWiring } = await import('../src/core/subagent-wiring.js');
const { busyBegin, openBusyItems, releaseBusyOpenedBefore } = await import('../src/ocupada.js');

afterEach(() => {
  releaseBusyOpenedBefore(Date.now() + 60_000);
});

/** Hijo falso que, como PersonalAgent.run, abre su marca de «ocupada» con su busyOwner. */
function wiringRecording(seen: Array<string | undefined>) {
  return createDelegateWiring({
    config: { maxToolCalls: 20 } as unknown as Config,
    parentTools: () => [],
    createAgent: async () => {
      const child = {
        busyOwner: undefined as string | undefined,
        run: async () => {
          seen.push(child.busyOwner);
          const end = busyBegin('turnos', 'hijo', child.busyOwner);
          // /stop en OTRO chat mientras el hijo trabaja.
          const freed = releaseBusyOpenedBefore(Date.now() + 1, 'telegram:111');
          const still = openBusyItems().some((i) => i.label === 'hijo');
          end();
          return { text: `liberadas=${freed} sigue=${still}`, toolCalls: 0, error: null };
        },
        abort: () => {},
      };
      return child as never;
    },
  });
}

describe('delegate: el hijo marca «ocupada» a nombre del chat que delega', () => {
  it('/stop en otro chat no suelta la marca del subagente que trabaja para este chat', async () => {
    const seen: Array<string | undefined> = [];
    const w = wiringRecording(seen);
    const tool = w.forThread(() => [], undefined, undefined, 'telegram:-222');
    const res = await tool.execute('d1', { task: 'resume estas webs', tools: [] } as never);
    expect(seen).toEqual(['telegram:-222']);
    const text = JSON.stringify(res.content);
    expect(text).toContain('liberadas=0 sigue=true');
  });

  it('sin chat (tool del proceso) sigue como antes: sin dueño', async () => {
    const seen: Array<string | undefined> = [];
    const w = wiringRecording(seen);
    await w.tool.execute('d2', { task: 'resume', tools: [] } as never);
    expect(seen).toEqual([undefined]);
  });

  it('en segundo plano el hijo también lleva el chat', async () => {
    const seen: Array<string | undefined> = [];
    const w = wiringRecording(seen);
    let done: Promise<string> | undefined;
    const tool = w.forThread(
      () => [],
      undefined,
      (job) => {
        done = job.run(new AbortController().signal);
        return true;
      },
      'telegram:-222',
    );
    await tool.execute('d3', { task: 'investiga', tools: [], background: true } as never);
    await done;
    expect(seen).toEqual(['telegram:-222']);
  });

  it('el daemon pasa el chat del hilo a la delegación', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(/startBackgroundDelegate\(thread, job\),[\s\S]{0,160}thread\.chatKey,/);
    expect(cli).toMatch(/forThread\(threadTools, approve, background, owner\)/);
  });
});

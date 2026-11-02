import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { type KindleDeps, sendToKindle } from '../src/books/kindle.js';
import { createBookTool } from '../src/tools/book.js';

/**
 * Las preguntas del Kindle (enviar un libro por correo, guardar la dirección) van ligadas
 * a la vida del turno, como las de compras y especialistas: con /stop o el turno cortado,
 * la pregunta de Telegram se deniega y se queda sin botones. Solo puede denegar antes.
 */
const ACCOUNT = { address: 'nico@gmail.com' } as never;

describe('Kindle: la señal del turno llega a la pregunta', () => {
  it('sendToKindle pasa la señal a requireApproval', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const deps: KindleDeps = {
      getAddress: async () => 'nico_ab12@kindle.com',
      loadAccount: async () => ACCOUNT,
      send: async () => ({ ok: true }) as never,
      requireApproval: async (_a: string, _s: string, signal?: AbortSignal) => {
        seen.push(signal);
        return false;
      },
    };
    const turn = new AbortController();
    const book = { title: 'Libro', bytes: Buffer.from('x'), kind: 'epub' as const };
    expect(await sendToKindle(deps, book, turn.signal)).toEqual({ status: 'declined' });
    expect(seen).toEqual([turn.signal]);
  });

  it('set_kindle pregunta con la señal de la herramienta', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const tool = createBookTool({
      sendDocument: async () => true,
      kindle: {
        getAddress: async () => null,
        loadAccount: async () => null,
        send: async () => ({ ok: true }),
        requireApproval: async (_a: string, _s: string, signal?: AbortSignal) => {
          seen.push(signal);
          return false;
        },
      },
      saveKindleAddress: async () => undefined,
    } as never) as unknown as AgentTool;
    const turn = new AbortController();
    await tool.execute(
      '1',
      { action: 'set_kindle', address: 'a@kindle.com' } as never,
      turn.signal,
    );
    expect(seen).toEqual([turn.signal]);
  });

  it('cli.ts lleva la señal del Kindle hasta la pregunta de Telegram', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toContain('requireApproval: (_action, summary, signal) =>');
    expect(src).toContain(['askOncePerTurn(thread, `¿$', '{summary}?`, signal)'].join(''));
  });
});

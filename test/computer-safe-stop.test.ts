import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import {
  type ActionGate,
  type BatchItemResult,
  createComputerTool,
  type ScreenBackend,
} from '../src/tools/computer.js';

/**
 * Parada segura: /stop aborta la ejecución del agente, pero un `batch` ya en marcha
 * seguía haciendo clic y tecleando todos sus pasos. Ahora mira la señal antes de
 * cada paso: el que está en curso termina y ninguno nuevo empieza.
 */

function backendWith(onKey?: (key: string) => void) {
  const calls: string[] = [];
  const backend: ScreenBackend = {
    screenshot: async () => ({
      image: Buffer.from('f'),
      mimeType: 'image/jpeg',
      width: 100,
      height: 100,
      nativeWidth: 100,
      nativeHeight: 100,
    }),
    click: async (x, y) => {
      calls.push(`click:${x},${y}`);
    },
    move: async () => {},
    drag: async () => {},
    type: async (t) => {
      calls.push(`type:${t}`);
    },
    key: async (k) => {
      calls.push(`key:${k}`);
      onKey?.(k);
    },
    screenSize: async () => ({ width: 100, height: 100 }),
  };
  return { backend, calls };
}

const allow: ActionGate = () => ({ verdict: 'allow', reason: '' });
const config = { verifyActions: false } as Config;

describe('computer · parada segura', () => {
  it('un batch se corta en cuanto se aborta la ejecución', async () => {
    const ctrl = new AbortController();
    const { backend, calls } = backendWith((k) => {
      if (k === 'b') ctrl.abort();
    });
    const tool = createComputerTool(config, backend, allow);
    const r = await tool.execute(
      't',
      {
        action: 'batch',
        actions: [
          { action: 'key', key: 'a' },
          { action: 'key', key: 'b' },
          { action: 'key', key: 'c' },
          { action: 'type', text: 'no' },
        ],
      },
      ctrl.signal,
    );
    expect(calls).toEqual(['key:a', 'key:b']);
    const results = (r.details as { results: BatchItemResult[] }).results;
    expect(results.map((x) => x.ok)).toEqual([true, true, false, false]);
    expect(results[2]?.error).toMatch(/cancelled/);
    const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(text).toMatch(/2 ok, 2 not executed/);
  });

  it('un batch que llega ya abortado no ejecuta nada', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { backend, calls } = backendWith();
    const tool = createComputerTool(config, backend, allow);
    await tool.execute(
      't',
      { action: 'batch', actions: [{ action: 'click', x: 1, y: 1 }] },
      ctrl.signal,
    );
    expect(calls).toEqual([]);
  });

  it('una acción suelta tras la parada no toca ratón ni teclado; una captura sí se permite', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { backend, calls } = backendWith();
    const tool = createComputerTool(config, backend, allow);
    await expect(tool.execute('t', { action: 'key', key: 'enter' }, ctrl.signal)).rejects.toThrow(
      /cancelled/,
    );
    await expect(tool.execute('t', { action: 'click', x: 1, y: 1 }, ctrl.signal)).rejects.toThrow(
      /cancelled/,
    );
    await tool.execute('s', { action: 'screenshot' }, ctrl.signal);
    expect(calls).toEqual([]);
  });

  it('sin señal todo sigue igual', async () => {
    const { backend, calls } = backendWith();
    const tool = createComputerTool(config, backend, allow);
    await tool.execute('t', {
      action: 'batch',
      actions: [
        { action: 'key', key: 'a' },
        { action: 'key', key: 'b' },
      ],
    });
    expect(calls).toEqual(['key:a', 'key:b']);
  });
});

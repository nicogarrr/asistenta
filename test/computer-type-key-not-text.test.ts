import { describe, expect, it } from 'vitest';

/**
 * type/key con un objeto, una lista o un booleano (posible en un elemento de
 * lote, que no pasa por el esquema) escribían «[object Object]», «a,b» o «true»
 * en el escritorio real. Ahora se niegan con el error de siempre y no se
 * escribe nada. Una cadena o un número (un código) siguen igual.
 * Backend falso: nada toca un PC.
 */

import type { Config } from '../src/config.js';
import type { Screenshot } from '../src/screen/verify.js';
import { type ActionGate, createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

function fake() {
  const calls: string[] = [];
  const backend: ScreenBackend = {
    screenshot: async (): Promise<Screenshot> => ({
      image: Buffer.from('frame'),
      mimeType: 'image/jpeg',
      width: 1280,
      height: 720,
      nativeWidth: 1280,
      nativeHeight: 720,
    }),
    click: async () => {},
    move: async () => {},
    drag: async () => {},
    type: async (text) => {
      calls.push(`type:${text}`);
    },
    key: async (key) => {
      calls.push(`key:${key}`);
    },
    screenSize: async () => ({ width: 1280, height: 720 }),
  };
  return { backend, calls };
}

const allowAll: ActionGate = () => ({ verdict: 'allow', reason: '' });
const config = { screenshotMaxEdge: 1280, verifyActions: false, verifySettleMs: 1 } as Config;

async function said(
  tool: ReturnType<typeof createComputerTool>,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const r = await tool.execute('t', args as never);
    return r.content.map((c) => ('text' in c ? (c.text ?? '') : '')).join('\n');
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('computer: type/key solo con texto de verdad', () => {
  it('objeto, lista o booleano en type/key se niegan y no se escribe nada', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(config, backend, allowAll);
    for (const v of [{ a: 1 }, ['a', 'b'], true, Number.NaN]) {
      expect(await said(tool, { action: 'type', text: v })).toMatch(
        /la acción type necesita texto/,
      );
      expect(await said(tool, { action: 'key', key: v })).toMatch(
        /la acción key necesita el nombre de una tecla/,
      );
    }
    const m = await said(tool, { action: 'batch', actions: [{ action: 'type', text: { a: 1 } }] });
    expect(m).toMatch(/la acción type necesita texto/);
    expect(calls).toEqual([]);
  });

  it('una cadena o un número siguen escribiéndose', async () => {
    const { backend, calls } = fake();
    const tool = createComputerTool(config, backend, allowAll);
    await said(tool, { action: 'type', text: 'hola' });
    await said(tool, { action: 'type', text: 482913 });
    await said(tool, { action: 'key', key: 'enter' });
    expect(calls).toEqual(['type:hola', 'type:482913', 'key:enter']);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { baseTools } from '../src/core/tool-registry.js';
import { ThreadOutputs, threadContext } from '../src/daemon/thread-context.js';
import { computerPlugin } from '../src/plugins/computer.js';
import { type ActionGate, createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

const config = {} as Config;
const screen = {} as ScreenBackend;
const gate: ActionGate = async () => ({ allowed: true }) as never;

function shape(t: { name: string; label?: string; description: string; parameters: unknown }) {
  return JSON.stringify({ n: t.name, l: t.label, d: t.description, p: t.parameters });
}

describe('pa chat / pa run usan el plugin de Computer Use (sin cambio de comportamiento)', () => {
  it('tool-registry ya no construye Computer Use a mano: usa computerPlugin', () => {
    const src = readFileSync(new URL('../src/core/tool-registry.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/createComputerTool\(/);
    expect(src).toMatch(/computerPlugin\.tools\(/);
  });

  it('sin canal, el plugin da la misma tool que createComputerTool sin envío de capturas', () => {
    const ctx = threadContext({ key: 'local', outputs: new ThreadOutputs(), gate });
    const [viaPlugin] = computerPlugin.tools({ config, screen, ctx });
    const direct = createComputerTool(config, screen, gate);
    expect(viaPlugin).toBeDefined();
    expect(shape(viaPlugin as never)).toBe(shape(direct as never));
  });

  it('la tool de computer use de baseTools es la de siempre', () => {
    const tools = baseTools({
      config,
      screen,
      computerGate: gate,
      delegate: { name: 'delegate' } as never,
      onFactoryChange: () => {},
    } as never);
    const cu = tools.find((t) => t.name === createComputerTool(config, screen, gate).name);
    expect(cu).toBeDefined();
    expect(shape(cu as never)).toBe(shape(createComputerTool(config, screen, gate) as never));
    expect(tools.at(-1)).toBe(cu);
  });
});

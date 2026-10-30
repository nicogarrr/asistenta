import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/tools/computer.js', () => ({
  createComputerTool: vi.fn((...args: unknown[]) => ({ name: 'computer', args })),
}));

const { computerPlugin } = await import('../src/plugins/computer.js');
const { ThreadOutputs, threadContext } = await import('../src/daemon/thread-context.js');
const { createComputerTool } = await import('../src/tools/computer.js');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
type SendPhoto = (b: Buffer, o: { width: number; height: number }) => Promise<boolean>;

function build() {
  const outputs = new ThreadOutputs();
  const gate = vi.fn();
  const ctx = threadContext({ key: 'tg:1:5', outputs, gate });
  const channelPhoto = vi.fn(async () => true);
  const config = { computerUse: true } as never;
  const screen = {} as never;
  const tools = computerPlugin.tools({ config, screen, ctx, channelPhoto });
  const args = (tools[0] as unknown as { args: unknown[] }).args;
  return { outputs, gate, channelPhoto, config, screen, tools, args };
}

describe('Computer Use como plugin', () => {
  it('construye una sola tool con la config, la pantalla y el Gate del hilo', () => {
    const b = build();
    expect(computerPlugin.id).toBe('computer');
    expect(b.tools).toHaveLength(1);
    expect(createComputerTool).toHaveBeenCalled();
    expect(b.args[0]).toBe(b.config);
    expect(b.args[1]).toBe(b.screen);
    expect(b.args[2]).toBe(b.gate);
  });

  it('fuera del panel la captura es exactamente el envío por el canal (mismas medidas, mismo resultado)', async () => {
    const b = build();
    b.channelPhoto.mockResolvedValueOnce(false);
    expect(await (b.args[3] as SendPhoto)(PNG, { width: 10, height: 20 })).toBe(false);
    expect(b.channelPhoto).toHaveBeenCalledWith(PNG, { width: 10, height: 20 });
  });

  it('en un turno del panel la captura va al panel y nada sale por el canal', async () => {
    const b = build();
    const photo = vi.fn();
    b.outputs.bind('tg:1:5', { answer: () => {}, note: () => {}, photo });
    expect(await (b.args[3] as SendPhoto)(PNG, { width: 1, height: 1 })).toBe(true);
    expect(photo).toHaveBeenCalledWith(PNG);
    expect(b.channelPhoto).not.toHaveBeenCalled();
  });

  it('cli.ts ya no construye Computer Use a mano en threadTools', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('createComputerTool(');
    expect(src).toContain('...computerPlugin.tools({');
  });
});

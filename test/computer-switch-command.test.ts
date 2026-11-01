import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { computerSwitchCommand } from '../src/screen/computer-switch.js';
import { createComputerTool, type ScreenBackend } from '../src/tools/computer.js';

/** /ordenador on|off: el interruptor de Computer Use desde Telegram, solo el dueño. */
function deps(isOwner: boolean, start = true) {
  const state = { on: start, sets: 0 };
  return {
    state,
    d: {
      isOwner,
      enabled: () => state.on,
      set: (v: boolean) => {
        state.on = v;
        state.sets++;
      },
    },
  };
}

describe('/ordenador · interruptor de Computer Use', () => {
  it('quien no es el dueño (o no está en privado) no cambia nada', () => {
    const { state, d } = deps(false);
    expect(computerSwitchCommand('off', d)).toMatch(/Solo el dueño/);
    expect(state).toEqual({ on: true, sets: 0 });
  });

  it('sin argumento dice el estado sin tocarlo', () => {
    const { state, d } = deps(true, false);
    expect(computerSwitchCommand('', d)).toContain('DESACTIVADO');
    expect(state.sets).toBe(0);
  });

  it('off / apagar desactiva y on / activa lo vuelve a encender', () => {
    const { state, d } = deps(true);
    expect(computerSwitchCommand('apagar', d)).toContain('desactivado');
    expect(state.on).toBe(false);
    expect(computerSwitchCommand(' ON ', d)).toContain('activado');
    expect(state.on).toBe(true);
  });

  it('una palabra desconocida no cambia nada y enseña el uso', () => {
    const { state, d } = deps(true);
    expect(computerSwitchCommand('quizás', d)).toMatch(/^¿Enciendo o apago el control de tu PC\?/);
    expect(state.sets).toBe(0);
  });

  it('apagado en caliente: la siguiente acción se rechaza sin tocar el backend', async () => {
    const config = {
      screenshotMaxEdge: 1280,
      screenshotQuality: 80,
      verifyActions: false,
      verifySettleMs: 1,
    } as Config;
    const calls: string[] = [];
    const backend = new Proxy(
      {},
      {
        get: (_t, k) => async () => {
          calls.push(String(k));
        },
      },
    ) as unknown as ScreenBackend;
    const tool = createComputerTool(config, backend);
    computerSwitchCommand('off', {
      isOwner: true,
      enabled: () => config.computerUse !== false,
      set: (v) => {
        config.computerUse = v;
      },
    });
    await expect(tool.execute('1', { action: 'screenshot' } as never)).rejects.toThrow(
      /PA_COMPUTER_USE=0/,
    );
    expect(calls.filter((c) => c !== 'setScaling' && c !== 'then')).toEqual([]);
  });
});

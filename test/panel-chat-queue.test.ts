import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type PanelChatThread, runPanelChat } from '../src/daemon/panel-chat.js';

function fakeThread(reply: (text: string) => Promise<string>) {
  const calls: string[] = [];
  const cleared: string[] = [];
  const thread: PanelChatThread = {
    key: 'telegram:dm:1#main',
    generation: 0,
    tail: Promise.resolve(),
    active: false,
    agent: {
      attachContext: (note) => calls.push(`ctx:${note}`),
      run: async (text) => {
        calls.push(`run:${text}`);
        return { text: await reply(text) };
      },
    },
    gate: { clearSession: (k) => cleared.push(k) },
  };
  return { thread, calls, cleared };
}

describe('chat del panel: misma cola por hilo que el resto de canales', () => {
  it('espera al turno vivo del hilo antes de correr y devuelve el texto', async () => {
    const { thread, calls } = fakeThread(async (t) => `eco ${t}`);
    let release!: () => void;
    thread.tail = new Promise<void>((r) => {
      release = r;
    });
    const p = runPanelChat(thread, 'hola', () => 'nota');
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toEqual([]);
    release();
    await expect(p).resolves.toEqual({ text: 'eco hola' });
    expect(calls).toEqual(['ctx:nota', 'run:hola']);
  });

  it('si el hilo se reinicia mientras espera, no corre y devuelve texto vacío', async () => {
    const { thread, calls } = fakeThread(async () => 'no');
    let release!: () => void;
    thread.tail = new Promise<void>((r) => {
      release = r;
    });
    const p = runPanelChat(thread, 'hola', () => 'nota');
    thread.generation++;
    release();
    await expect(p).resolves.toEqual({ text: '' });
    expect(calls).toEqual([]);
  });

  it('marca el hilo activo solo durante el turno y limpia la sesión del Gate aunque falle', async () => {
    const { thread, cleared } = fakeThread(async () => {
      expect(thread.active).toBe(true);
      throw new Error('modelo caído');
    });
    await expect(runPanelChat(thread, 'x', () => 'n')).rejects.toThrow('modelo caído');
    expect(thread.active).toBe(false);
    expect(cleared).toEqual(['telegram:dm:1#main']);
    // La cola sigue viva para el siguiente turno.
    await expect(thread.tail).resolves.toBeUndefined();
  });

  it('cli.ts usa runPanelChat y no lleva su propia cola para el panel', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(/return runPanelChat\(thread, text, \(\) =>/);
  });
});

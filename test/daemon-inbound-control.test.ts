import { describe, expect, it } from 'vitest';
import { routeInboundControl } from '../src/daemon/inbound.js';
import { EraseConfirm } from '../src/erase-command.js';

type Msg = { text: string };

function harness(pendingErase = false) {
  const calls: string[] = [];
  const erase = new EraseConfirm();
  if (pendingErase) erase.request('chat');
  const deps = {
    mailReply: async (m: Msg) => calls.push(`correo:${m.text.split('\n')[1]}`),
    consumeErase: (key: string, text: string) => erase.consume(key, text),
    eraseConfirmed: async () => calls.push('borrado'),
    eraseCancelled: async () => calls.push('cancelado'),
    parseCommand: (text: string): string | null =>
      text.startsWith('/') ? (text.slice(1).split(' ')[0] ?? '') : null,
    runCommand: async (_m: Msg, c: string) => calls.push(`cmd:${c}`),
  };
  return { calls, run: (text: string) => routeInboundControl({ text }, 'chat', deps) };
}

describe('routeInboundControl (correo, /borrar_chat y comandos antes del hilo)', () => {
  it('un mensaje normal sigue hacia el hilo sin tocar nada', async () => {
    const h = harness();
    expect(await h.run('qué tiempo hace')).toBe('continue');
    expect(h.calls).toEqual([]);
  });

  it('«responde a ese» va a /correo y no llega a comandos', async () => {
    const h = harness(true);
    expect(await h.run('responde a ese\nvale, el martes')).toBe('handled');
    // la respuesta al correo va antes que la confirmación pendiente, que sigue pendiente
    expect(h.calls).toEqual(['correo:vale, el martes']);
    expect(await h.run('BORRAR')).toBe('handled');
    expect(h.calls).toEqual(['correo:vale, el martes', 'borrado']);
  });

  it('«BORRAR» con confirmación pendiente borra y no se trata como petición', async () => {
    const h = harness(true);
    expect(await h.run('BORRAR')).toBe('handled');
    expect(h.calls).toEqual(['borrado']);
  });

  it('otra cosa con confirmación pendiente cancela y el mensaje sigue su camino', async () => {
    const h = harness(true);
    expect(await h.run('/estado')).toBe('handled');
    expect(h.calls).toEqual(['cancelado', 'cmd:estado']);
    const h2 = harness(true);
    expect(await h2.run('mejor no')).toBe('continue');
    expect(h2.calls).toEqual(['cancelado']);
  });

  it('«BORRAR» sin nada pendiente no borra nada', async () => {
    const h = harness();
    expect(await h.run('BORRAR')).toBe('continue');
    expect(h.calls).toEqual([]);
  });

  it('un comando no pasa por el hilo', async () => {
    const h = harness();
    expect(await h.run('/help')).toBe('handled');
    expect(h.calls).toEqual(['cmd:help']);
  });
});

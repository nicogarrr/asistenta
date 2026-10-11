/**
 * Adversarial del auditor (11 oct, ronda 2): el socket de input NUNCA emite
 * open ni send; tvKey no debe reportar exito. Pinna que el margen de consumo
 * empieza solo tras open+send.
 */

import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

class Main extends EventEmitter {
  constructor() {
    super();
    queueMicrotask(() => this.emit('open'));
  }
  close() {}
  send(x: string) {
    const m = JSON.parse(x);
    queueMicrotask(() =>
      this.emit(
        'message',
        JSON.stringify(
          m.type === 'register'
            ? { id: m.id, type: 'registered', payload: { 'client-key': 'fake' } }
            : {
                id: m.id,
                type: 'response',
                payload: { returnValue: true, socketPath: 'wss://192.168.1.237:3001/input' },
              },
        ),
      ),
    );
  }
}

it('never reports key sent before input socket open', async () => {
  vi.resetModules();
  let sends = 0;
  vi.doMock('ws', () => ({
    default: class extends EventEmitter {
      send() {
        sends++;
      }
      close() {
        this.emit('close');
      }
    },
  }));
  const { tvKey } = await import('../src/tv/lgtv.js');
  await expect(
    tvKey('192.168.1.237', 'fake', 'HOME', { factory: () => new Main() }),
  ).rejects.toThrow();
  expect(sends).toBe(0);
  vi.doUnmock('ws');
}, 8000);

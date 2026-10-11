/**
 * Adversariales del auditor (post-hoc e66a711, 11 oct): power sin `on` no
 * puede tener efecto; las teclas de volumen anunciadas deben cruzar la
 * whitelist REAL de lgtv.ts; y un frame pequeno no puede afirmar DRM ni
 * mandar a confirmar con un recuerdo (state es cache, no presente).
 *
 * Adaptacion sandbox del test 2: la version del auditor llamaba a tvKey sin
 * factory (red real a 192.168.1.237, impropas en CI). Aqui va con el MISMO
 * mock SSAP de sus otros adversariales; la asercion se mantiene y se
 * refuerza con el payload capturado (VOLUP -> VOLUMEUP).
 */

import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';

const d = (over: Partial<TvToolDeps> = {}): TvToolDeps => ({
  shot: async () => ({ image: Buffer.alloc(1500), mimeType: 'image/jpeg' }),
  foreground: async () => ({ appId: 'org.webosbrew.hbchannel', category: [] }),
  apps: async () => [],
  launch: async () => {},
  key: async () => {},
  toast: async () => {},
  power: async () => {},
  saveFrame: () => '/tmp/frame.jpg',
  getState: () => null,
  setState: () => {},
  ...over,
});

it('missing on cannot switch TV off', async () => {
  let calls = 0;
  const tool = createTvTool(
    d({
      power: async () => {
        calls++;
      },
    }),
  );
  await expect(tool.execute('id', { action: 'power' })).rejects.toThrow();
  expect(calls).toBe(0);
});

it('advertised volume keys work with real adapter whitelist', async () => {
  vi.resetModules();
  const sent: string[] = [];
  class Main extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    close() {
      this.emit('close');
    }
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
  vi.doMock('ws', () => ({
    default: class extends EventEmitter {
      constructor() {
        super();
        queueMicrotask(() => this.emit('open'));
      }
      close() {
        this.emit('close');
      }
      send(data: string) {
        sent.push(data);
      }
    },
  }));
  const { tvKey } = await import('../src/tv/lgtv.js');
  await expect(
    createTvTool(
      d({ key: async (n) => tvKey('192.168.1.237', 'fake', n, { factory: () => new Main() }) }),
    ).execute('id', { action: 'key', name: 'VOLUP' }),
  ).resolves.toBeDefined();
  expect(sent).toEqual(['type:button\nname:VOLUMEUP\n\n']);
  vi.doUnmock('ws');
}, 8000);

it('small ordinary UI frame must not assert DRM or tell stale state can confirm', async () => {
  const result = await createTvTool(d()).execute('id', { action: 'screenshot' });
  const text = result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join(' ');
  expect(text).not.toMatch(/probable es contenido con DRM/);
  expect(text).not.toMatch(/confirma con action=state/);
});

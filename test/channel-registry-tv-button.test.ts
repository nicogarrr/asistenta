import { describe, expect, it } from 'vitest';
import { ChannelRegistry } from '../src/channels/registry.js';
import type { ChannelAdapter, ChannelHandlers } from '../src/channels/types.js';

/**
 * Los botones del mando de /tv viajan Telegram → adaptador → `onTvButton` del
 * daemon. El registro construye el objeto de handlers que recibe cada adaptador,
 * y antes se dejaba `onTvButton` fuera: en el daemon real cada pulsación
 * contestaba «Este botón ya no sirve» sin mandar nada a la tele.
 */
function fakeAdapter(): { adapter: ChannelAdapter; got: () => ChannelHandlers | undefined } {
  let got: ChannelHandlers | undefined;
  const adapter = {
    name: 'fake',
    account: 'a',
    start: async (h: ChannelHandlers) => {
      got = h;
    },
    stop: async () => {},
    send: async () => {},
    isReady: () => true,
  } as unknown as ChannelAdapter;
  return { adapter, got: () => got };
}

describe('ChannelRegistry: botones de /tv', () => {
  it('pasa onTvButton del daemon al adaptador y devuelve su respuesta', async () => {
    const registry = new ChannelRegistry();
    const { adapter, got } = fakeAdapter();
    registry.register(adapter);
    const presses: string[] = [];
    await registry.startAll({
      onMessage: () => {},
      onTvButton: async (press: { chatId: string; data: string }) => {
        presses.push(`${press.chatId}:${press.data}`);
        return 'Hecho';
      },
    } as unknown as ChannelHandlers);
    const handlers = got();
    expect(handlers?.onTvButton).toBeTypeOf('function');
    const reply = await handlers?.onTvButton?.({
      channel: 'telegram',
      chatId: '42',
      userId: '7',
      data: 'tv:on',
    });
    expect(reply).toBe('Hecho');
    expect(presses).toEqual(['42:tv:on']);
  });

  it('sin onTvButton en el daemon el adaptador tampoco lo ve (sigue el aviso de botón caducado)', async () => {
    const registry = new ChannelRegistry();
    const { adapter, got } = fakeAdapter();
    registry.register(adapter);
    await registry.startAll({ onMessage: () => {} } as unknown as ChannelHandlers);
    expect(got()?.onTvButton).toBeUndefined();
  });
});

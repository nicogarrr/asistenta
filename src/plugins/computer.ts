/**
 * Computer Use como plugin (ARCHITECTURE.md §5, arch8).
 *
 * Movido tal cual de threadTools en cli.ts: la misma `createComputerTool` con el
 * mismo Gate del hilo y el mismo envío de capturas. La diferencia es de dónde salen:
 * del contexto tipado de la conversación (`ThreadContext`, src/daemon/thread-context.ts)
 * en vez de cierres sueltos de cli.ts. Así una captura de un turno del panel va al
 * panel, y en Telegram el envío es exactamente el de siempre (`channelPhoto`).
 *
 * El interruptor /ordenador sigue en `config.computerUse`, que la propia tool lee.
 */
import type { Config } from '../config.js';
import type { ThreadContext } from '../daemon/thread-context.js';
import { type ActionGate, createComputerTool, type ScreenBackend } from '../tools/computer.js';
import type { CapabilityPlugin } from './types.js';

export interface ComputerPluginDeps {
  config: Config;
  screen: ScreenBackend;
  /** Contexto del hilo: su Gate y a dónde van las capturas. */
  ctx: ThreadContext<ActionGate>;
  /**
   * Cómo manda una captura el canal del hilo (Telegram) cuando el turno no es del panel.
   * Sin él (consola `pa chat`, `pa run`) la tool no tiene a dónde mandar capturas, como antes.
   */
  channelPhoto?: (bytes: Buffer, opts: { width: number; height: number }) => Promise<boolean>;
}

export const computerPlugin: CapabilityPlugin<ComputerPluginDeps> = {
  id: 'computer',
  tools: ({ config, screen, ctx, channelPhoto }) => [
    channelPhoto
      ? createComputerTool(config, screen, ctx.gate, (bytes, opts) =>
          ctx.sendPhoto(bytes, () => channelPhoto(bytes, opts)),
        )
      : createComputerTool(config, screen, ctx.gate),
  ],
};

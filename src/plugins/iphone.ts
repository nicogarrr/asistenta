/**
 * Plugin del iPhone (esp32-iphone-agent): su cableado vive aquí y no en cli.ts.
 *
 * Movido tal cual desde cli.ts (sin cambiar comportamiento), con el mismo patrón que
 * la tele (src/plugins/tv.ts). Ver ARCHITECTURE.md §4.
 */
import { IphoneClient } from '../iphone/client.js';
import { createIphoneTool, type IphoneToolDeps } from '../tools/iphone.js';
import { vaultGet } from '../vault.js';
import type { CapabilityPlugin } from './types.js';

/**
 * Cableado de la tool `iphone` al servidor hidagent (esp32-iphone-agent).
 * La URL vive en el vault (iphone:url) o en PA_IPHONE_URL. Sin ella, cada
 * accion falla con un mensaje legible: el telefono es opcional y su ausencia
 * no puede tumbar el arranque.
 */
export function iphoneToolDeps(): IphoneToolDeps {
  const client = async (): Promise<IphoneClient> => {
    const url = (await vaultGet('iphone:url')) || process.env.PA_IPHONE_URL?.trim();
    if (!url) {
      throw new Error(
        'El puente del iPhone no esta configurado: guarda su URL en el vault (iphone:url) o PA_IPHONE_URL. Ver deploy/iphone/README.md.',
      );
    }
    return new IphoneClient({ baseUrl: url });
  };
  return {
    status: async () => (await client()).status(),
    frame: async () => (await client()).frame(),
    start: async (goal) => (await client()).start(goal),
    stop: async () => (await client()).stop(),
    home: async () => (await client()).home(),
  };
}

export const iphonePlugin: CapabilityPlugin<Record<string, never>> = {
  id: 'iphone',
  tools: () => [createIphoneTool(iphoneToolDeps())],
};

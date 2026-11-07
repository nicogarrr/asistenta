/**
 * Plugin del iPhone (esp32-iphone-agent): su cableado vive aquí y no en cli.ts.
 *
 * Movido tal cual desde cli.ts (sin cambiar comportamiento), con el mismo patrón que
 * la tele (src/plugins/tv.ts). Ver ARCHITECTURE.md §4.
 */
import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IphoneClient } from '../iphone/client.js';
import { ocrImage } from '../screen/ocr.js';
import { createIphoneTool, type IphoneToolDeps } from '../tools/iphone.js';
import { vaultGet } from '../vault.js';
import type { CapabilityPlugin } from './types.js';

/**
 * OCR de una captura del iPhone con el OCR que ya trae Windows (sin instalar nada, en CPU).
 * La captura va a un fichero temporal propio que se borra siempre al acabar.
 */
export async function ocrCapturaIphone(
  jpeg: Buffer,
  plataforma: NodeJS.Platform = process.platform,
  leer: typeof ocrImage = ocrImage,
) {
  if (plataforma !== 'win32') {
    throw new Error(
      'Leer la pantalla del iPhone en texto usa el OCR de Windows y este equipo no es Windows. Usa action=screenshot.',
    );
  }
  const ruta = join(
    tmpdir(),
    `asistenta-iphone-${process.pid}-${randomBytes(4).toString('hex')}.jpg`,
  );
  await writeFile(ruta, jpeg, { mode: 0o600 });
  try {
    return await leer(ruta);
  } finally {
    await rm(ruta, { force: true });
  }
}

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
    ocr: (jpeg) => ocrCapturaIphone(jpeg),
  };
}

export const iphonePlugin: CapabilityPlugin<Record<string, never>> = {
  id: 'iphone',
  tools: () => [createIphoneTool(iphoneToolDeps())],
};

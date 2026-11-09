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
import { bleActivado, type EstadoBle, faltanBle, ManosBle, ProcesoHid } from '../iphone/ble.js';
import { IphoneClient, type IphoneStatus, type SetupStep } from '../iphone/client.js';
import { puntosDePantalla } from '../iphone/hid-informes.js';
import { capturarVentanaUxplay } from '../iphone/ventana.js';
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

/** ¿Pasos sueltos en el iPhone? Solo con `PA_IPHONE_GESTOS=1` (por defecto, apagados). */
export function gestosActivados(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_IPHONE_GESTOS ?? '').trim() === '1';
}

/**
 * Cableado de la tool `iphone` al servidor hidagent (esp32-iphone-agent).
 * La URL vive en el vault (iphone:url) o en PA_IPHONE_URL. Sin ella, cada
 * accion falla con un mensaje legible: el telefono es opcional y su ausencia
 * no puede tumbar el arranque.
 */
export function iphoneToolDeps(env: NodeJS.ProcessEnv = process.env): IphoneToolDeps {
  if (bleActivado(env)) return iphoneBleDeps(env);
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
    // Pasos sueltos (tocar, escribir, abrir app...): apagados salvo PA_IPHONE_GESTOS=1.
    gestos: gestosActivados(),
    manos: {
      tap: async (x, y) => (await client()).tap(x, y),
      swipe: async (x1, y1, x2, y2) => (await client()).swipe(x1, y1, x2, y2),
      type: async (t) => (await client()).type(t),
      key: async (k) => (await client()).key(k),
      back: async () => (await client()).back(),
    },
  };
}

export const iphonePlugin: CapabilityPlugin<Record<string, never>> = {
  id: 'iphone',
  tools: () => [createIphoneTool(iphoneToolDeps())],
};

/** El ayudante BLE, uno por proceso (se arranca al primer uso). */
let procesoHid: ProcesoHid | null = null;

/** Alta guiada del modo Bluetooth: lo que se puede saber desde el PC, marcado. */
export function guiaBle(
  ble: { periferico: boolean; anunciando: boolean; conectado: boolean } | null,
  pantalla: boolean,
  problema?: string,
): { steps: SetupStep[]; next: string | null } {
  const steps: SetupStep[] = [
    {
      text: problema
        ? `Ayudante Bluetooth: no arranca (${problema}). Compílalo con deploy/iphone/windows/compilar-hid.ps1.`
        : 'Ayudante Bluetooth: arrancado.',
      done: ble !== null,
    },
    {
      text: 'El Bluetooth de este PC puede hacer de periférico LE (si no, hace falta otro adaptador; preparar-windows.ps1 lo comprueba).',
      done: ble?.periferico === true,
    },
    { text: 'Teclado y puntero anunciándose por Bluetooth.', done: ble?.anunciando === true },
    {
      text: 'En el iPhone: Ajustes > Accesibilidad > Tocar > AssistiveTouch ACTIVADO y «Control de permanencia» (Dwell) DESACTIVADO; luego Ajustes > Bluetooth > el nombre de este PC > enlazar.',
      done: ble?.conectado === true,
    },
    {
      text: 'Pantalla: arranca UxPlay en el PC (powershell -ExecutionPolicy Bypass -File deploy\\iphone\\windows\\preparar-windows.ps1 -Arrancar) y en el iPhone Centro de control > Duplicar pantalla > «Asistenta».',
      done: pantalla,
    },
  ];
  const pendiente = steps.find((s) => !s.done);
  return { steps, next: pendiente ? pendiente.text : null };
}

/**
 * Modo Bluetooth (PA_IPHONE_BLE=1): sin ESP32 ni hidagent. Manos = el PC como teclado y
 * puntero absoluto por HID sobre GATT; ojos = la ventana de UxPlay + OCR de Windows.
 * No hay agente del teléfono: `run` lo explica; `stop` suelta todo; `home` es Cmd+H.
 */
export function iphoneBleDeps(env: NodeJS.ProcessEnv = process.env): IphoneToolDeps {
  procesoHid ??= new ProcesoHid();
  const manos = new ManosBle(procesoHid, puntosDePantalla(env.PA_IPHONE_PUNTOS));
  let ultimaCaptura = 0;
  const frame = async () => {
    const { jpeg } = await capturarVentanaUxplay();
    ultimaCaptura = Date.now();
    return jpeg;
  };
  const hayPantalla = async () => {
    if (Date.now() - ultimaCaptura < 5_000) return true;
    try {
      await frame();
      return true;
    } catch {
      return false;
    }
  };
  let ultimoBle: EstadoBle | null = null;
  return {
    modo: 'ble',
    status: async (): Promise<IphoneStatus> => {
      ultimoBle = await manos.estado();
      const e = ultimoBle;
      return {
        device: e.periferico && e.anunciando && e.conectado,
        screen: await hayPantalla(),
        calibrated: true, // puntero absoluto: no hay calibrado
        models: { planner: '', actor: '' },
        agent: { running: false, task: null, steps: 0 },
      };
    },
    faltan: (s) => [
      ...(ultimoBle
        ? faltanBle(ultimoBle)
        : s.device
          ? []
          : ['el iPhone no está conectado por Bluetooth']),
      ...(s.screen
        ? []
        : [
            'no veo la pantalla del iPhone: arranca UxPlay en el PC y en el iPhone Centro de control > Duplicar pantalla > «Asistenta»',
          ]),
    ],
    guia: (s, problema) => guiaBle(ultimoBle, s?.screen === true, problema),
    frame,
    start: async () => {
      throw new Error(
        'En modo Bluetooth no hay agente del teléfono: usa los pasos sueltos (texto, tocar_texto, abrir_app...).',
      );
    },
    stop: () => manos.soltar(),
    home: () => manos.key('cmd+h'),
    ocr: (jpeg) => ocrCapturaIphone(jpeg),
    gestos: true,
    manos,
  };
}

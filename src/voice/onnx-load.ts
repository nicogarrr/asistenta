import { readFile } from 'node:fs/promises';
import { ORT_SIN_ESPERA_ACTIVA } from '../onnx-ahorro.js';

/**
 * Abre una sesión ONNX desde una ruta de modelo, también cuando la ruta lleva tildes, eñes
 * u otros caracteres no ASCII. onnxruntime-node en Windows convierte la ruta con la página
 * de códigos del sistema y no encuentra «C:\Users\José\…\silero_vad.onnx»: la voz (VAD y
 * palabra de activación) no arrancaba para un usuario con tilde en su nombre. Con una ruta
 * así, el modelo se lee con Node (que sí entiende Unicode) y se pasa en bytes; una ruta
 * ASCII se sigue abriendo por ruta, como siempre.
 */
export interface OnnxSessionCreator<S> {
  InferenceSession: {
    create(path: string, options?: object): Promise<S>;
    create(bytes: Uint8Array, options?: object): Promise<S>;
  };
}

/** true si la ruta tiene algún carácter fuera de ASCII imprimible. */
export function needsByteLoad(modelPath: string): boolean {
  return /[^\x20-\x7e]/.test(modelPath);
}

export async function createOnnxSession<S>(
  ort: OnnxSessionCreator<S>,
  modelPath: string,
  read: (path: string) => Promise<Uint8Array> = readFile,
): Promise<S> {
  // Sin espera activa de los hilos (ver onnx-ahorro.ts): misma salida, menos CPU.
  if (!needsByteLoad(modelPath))
    return ort.InferenceSession.create(modelPath, ORT_SIN_ESPERA_ACTIVA);
  const bytes = await read(modelPath);
  return ort.InferenceSession.create(
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ORT_SIN_ESPERA_ACTIVA,
  );
}

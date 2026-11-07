import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  asegurarVozLocal,
  type Extraer,
  type VozLocal,
  vozLocalLista,
} from '../src/voice/voz-local.js';

const CONTENIDO = Buffer.from('supertonic de prueba '.repeat(500));
const sha = createHash('sha256').update(CONTENIDO).digest('hex');
const SUPERTONIC: VozLocal = {
  clave: 'supertonic-f2',
  id: 'sherpa-onnx-supertonic-3-tts-int8-prueba',
  url: 'https://example.invalid/supertonic.tar.bz2',
  sha256: sha,
  bytes: CONTENIDO.length,
  onnx: 'vector_estimator.int8.onnx',
  sid: 1,
  motor: 'supertonic',
};

/** Lo que trae de verdad el .tar.bz2 de Supertonic 3 (sin espeak-ng-data ni tokens.txt). */
const extraerSupertonic: Extraer = async (_archivo, destino) => {
  const dir = join(destino, SUPERTONIC.id);
  mkdirSync(dir, { recursive: true });
  for (const f of [
    'text_encoder.int8.onnx',
    'LICENSE',
    'tts.json',
    'README.md',
    'voice.bin',
    'unicode_indexer.bin',
    'duration_predictor.int8.onnx',
    'vector_estimator.int8.onnx',
    'vocoder.int8.onnx',
  ])
    writeFileSync(join(dir, f), 'x');
};

describe('Supertonic se instala de verdad (voz7)', () => {
  it('el archivo real de Supertonic (sin espeak-ng-data) queda listo, no se descarta', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'pa-voz7-st-'));
    let descargas = 0;
    const fetchImpl = (async () => {
      descargas++;
      return new Response(CONTENIDO, { status: 200 });
    }) as typeof fetch;
    const lista = await asegurarVozLocal(raiz, SUPERTONIC, {
      fetchImpl,
      extraer: extraerSupertonic,
      progreso: () => {},
    });
    expect(lista.supertonic?.vocoder).toMatch(/vocoder\.int8\.onnx$/);
    expect(vozLocalLista(raiz, SUPERTONIC)).not.toBeNull();
    // Ya lista: no se vuelve a bajar.
    await asegurarVozLocal(raiz, SUPERTONIC, {
      fetchImpl,
      extraer: extraerSupertonic,
      progreso: () => {},
    });
    expect(descargas).toBe(1);
  });

  it('un archivo al que le falta un fichero de Supertonic se descarta diciendo cuál', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'pa-voz7-st-'));
    const incompleto: Extraer = async (_a, destino) => {
      const dir = join(destino, SUPERTONIC.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'vector_estimator.int8.onnx'), 'x');
    };
    await expect(
      asegurarVozLocal(raiz, SUPERTONIC, {
        fetchImpl: (async () => new Response(CONTENIDO, { status: 200 })) as typeof fetch,
        extraer: incompleto,
        progreso: () => {},
      }),
    ).rejects.toThrow(/falta duration_predictor\.int8\.onnx/);
  });
});

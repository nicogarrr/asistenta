import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSherpaTts, type SherpaModulo } from '../src/voice/sherpa.js';
import type { Tts, TtsAudio } from '../src/voice/tts.js';
import {
  carpetaVozLocal,
  createTtsConVozLocal,
  VOCES_LOCALES,
  type VozLocal,
  vozLocalDesdeEnv,
  vozLocalLista,
} from '../src/voice/voz-local.js';

const audio = (text: string): TtsAudio => ({
  durationSeconds: 1,
  data: Buffer.from(text),
  mimeType: 'audio/mpeg',
  format: 'mp3',
  text,
  truncated: false,
});

/** Coloca un modelo «ya descargado» con los archivos que pide su motor. */
function colocar(raiz: string, voz: VozLocal): void {
  const dir = carpetaVozLocal(raiz, voz);
  mkdirSync(join(dir, 'espeak-ng-data'), { recursive: true });
  writeFileSync(join(dir, '.ok'), voz.sha256);
  writeFileSync(join(dir, voz.onnx), 'x');
  writeFileSync(join(dir, 'tokens.txt'), 'x');
  if (voz.motor === 'kokoro') writeFileSync(join(dir, 'voices.bin'), 'x');
}

describe('voz natural: Kokoro por defecto', () => {
  it('Kokoro (castellano) sigue a mano con PA_TTS_LOCAL=kokoro; sharvard también', () => {
    const k = vozLocalDesdeEnv({ PA_TTS_LOCAL: 'kokoro' }, 'win32');
    expect(k?.clave).toBe('kokoro');
    expect(k?.motor).toBe('kokoro');
    expect(vozLocalDesdeEnv({ PA_TTS_LOCAL: 'kokoro-alex' }, 'win32')?.sid).toBe(29);
    expect(vozLocalDesdeEnv({ PA_TTS_LOCAL: 'sharvard' }, 'win32')?.clave).toBe('sharvard');
  });

  it('Kokoro solo está lista con su tabla de voces, y da sus rutas', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'kokoro-'));
    const k = VOCES_LOCALES.kokoro as VozLocal;
    expect(vozLocalLista(raiz, k)).toBeNull();
    colocar(raiz, k);
    const lista = vozLocalLista(raiz, k);
    expect(lista?.kokoro?.voces).toBe(join(carpetaVozLocal(raiz, k), 'voices.bin'));
    expect(lista?.kokoro?.dict).toBe(join(carpetaVozLocal(raiz, k), 'dict'));
  });

  it('sherpa carga Kokoro con fonemas castellanos («es»), no como VITS', async () => {
    const configs: Array<{ model: Record<string, unknown> }> = [];
    const cargar = (): SherpaModulo => ({
      OfflineTts: {
        createAsync: async (c: unknown) => {
          configs.push(c as { model: Record<string, unknown> });
          return {
            generateAsync: async () => ({
              samples: new Float32Array(2400).fill(0.1),
              sampleRate: 24000,
            }),
          };
        },
      },
    });
    const tts = createSherpaTts({
      modelo: {
        onnx: '/k/model.onnx',
        tokens: '/k/tokens.txt',
        datos: '/k/espeak-ng-data',
        kokoro: { voces: '/k/voices.bin', lexicon: '/k/l.txt', dict: '/k/dict' },
      },
      cargar,
      hilos: 2,
      sid: 28,
    });
    await tts.speak('Hola, Nico.');
    expect(configs[0]?.model.vits).toBeUndefined();
    expect(configs[0]?.model.kokoro).toMatchObject({
      model: '/k/model.onnx',
      voices: '/k/voices.bin',
      lang: 'es',
    });
  });

  it('mientras Kokoro se descarga habla sharvard si ya estaba, no la voz robótica', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'kokoro-'));
    colocar(raiz, VOCES_LOCALES.sharvard as VozLocal);
    const usados: number[] = [];
    let respaldos = 0;
    const respaldo: Tts = {
      name: 'sapi',
      speak: async (t) => {
        respaldos++;
        return audio(t);
      },
    };
    const tts = createTtsConVozLocal(
      { PA_TTS_LOCAL: 'kokoro' },
      {
        respaldo,
        raiz,
        plataforma: 'win32',
        // La descarga nunca acaba en esta prueba.
        descarga: { fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch },
        crearLocal: (_modelo, sid) => ({
          name: 'sherpa',
          speak: async (t) => {
            usados.push(sid);
            return audio(t);
          },
        }),
      },
    );
    await tts.speak('Hola');
    expect(usados).toEqual([0]);
    expect(respaldos).toBe(0);
  });
});

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
  vozPuente,
} from '../src/voice/voz-local.js';

const audio = (text: string): TtsAudio => ({
  durationSeconds: 1,
  data: Buffer.from(text),
  mimeType: 'audio/mpeg',
  format: 'mp3',
  text,
  truncated: false,
});

const SUPERTONIC_ARCHIVOS = [
  'duration_predictor.int8.onnx',
  'text_encoder.int8.onnx',
  'vector_estimator.int8.onnx',
  'vocoder.int8.onnx',
  'tts.json',
  'unicode_indexer.bin',
  'voice.bin',
];

/** Coloca un modelo «ya descargado» con los archivos que pide su motor. */
function colocar(raiz: string, voz: VozLocal): void {
  const dir = carpetaVozLocal(raiz, voz);
  mkdirSync(join(dir, 'espeak-ng-data'), { recursive: true });
  writeFileSync(join(dir, '.ok'), voz.sha256);
  if (voz.motor === 'supertonic') {
    for (const f of SUPERTONIC_ARCHIVOS) writeFileSync(join(dir, f), 'x');
    return;
  }
  writeFileSync(join(dir, voz.onnx), 'x');
  writeFileSync(join(dir, 'tokens.txt'), 'x');
  if (voz.motor === 'kokoro') writeFileSync(join(dir, 'voices.bin'), 'x');
}

const supertonic = (): VozLocal => VOCES_LOCALES.supertonic as VozLocal;

describe('voz5: Supertonic 3, castellano natural y rápido en CPU', () => {
  it('PA_TTS_LOCAL=supertonic elige la voz de mujer F3 (sid 2); supertonic-f5 la F5', () => {
    const v = vozLocalDesdeEnv({ PA_TTS_LOCAL: 'supertonic' }, 'win32');
    expect(v?.motor).toBe('supertonic');
    expect(v?.sid).toBe(2);
    expect(v?.url).toContain('sherpa-onnx-supertonic-3-tts-int8');
    expect(vozLocalDesdeEnv({ PA_TTS_LOCAL: 'supertonic-f5' }, 'win32')?.sid).toBe(4);
  });

  it('por defecto en Windows habla Supertonic F2 (sid 1, la que eligió Nico), con Kokoro de puente', () => {
    const v = vozLocalDesdeEnv({}, 'win32');
    expect(v?.clave).toBe('supertonic-f2');
    expect(v?.motor).toBe('supertonic');
    expect(v?.sid).toBe(1);
    expect(vozLocalDesdeEnv({ PA_TTS_LOCAL: 'Supertonic-F2' }, 'win32')?.sid).toBe(1);
    expect(vozPuente(v as VozLocal)?.clave).toBe('kokoro');
  });

  it('solo está lista con sus siete archivos, sin tokens ni espeak', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'st3-'));
    const v = supertonic();
    expect(vozLocalLista(raiz, v)).toBeNull();
    colocar(raiz, v);
    const lista = vozLocalLista(raiz, v);
    const dir = carpetaVozLocal(raiz, v);
    expect(lista?.supertonic?.voiceStyle).toBe(join(dir, 'voice.bin'));
    expect(lista?.supertonic?.vocoder).toBe(join(dir, 'vocoder.int8.onnx'));
  });

  it('sherpa la carga como Supertonic y le pide castellano («es») con 8 pasos', async () => {
    const configs: Array<{ model: Record<string, unknown> }> = [];
    const pedidos: Array<Record<string, unknown>> = [];
    const cargar = (): SherpaModulo => ({
      OfflineTts: {
        createAsync: async (c: unknown) => {
          configs.push(c as { model: Record<string, unknown> });
          return {
            generateAsync: async (req) => {
              pedidos.push(req as unknown as Record<string, unknown>);
              return { samples: new Float32Array(4410).fill(0.1), sampleRate: 44100 };
            },
          };
        },
      },
    });
    const tts = createSherpaTts({
      modelo: {
        onnx: '/s/vector_estimator.int8.onnx',
        tokens: '',
        datos: '',
        supertonic: {
          durationPredictor: '/s/dp.onnx',
          textEncoder: '/s/te.onnx',
          vectorEstimator: '/s/vector_estimator.int8.onnx',
          vocoder: '/s/voc.onnx',
          ttsJson: '/s/tts.json',
          unicodeIndexer: '/s/ui.bin',
          voiceStyle: '/s/voice.bin',
        },
      },
      cargar,
      hilos: 4,
      sid: 2,
    });
    const r = await tts.speak('Hola, Nico.');
    expect(r.format).toBe('mp3');
    expect(configs[0]?.model.vits).toBeUndefined();
    expect(configs[0]?.model.supertonic).toMatchObject({ voiceStyle: '/s/voice.bin' });
    expect(pedidos[0]?.generationConfig).toEqual({
      sid: 2,
      speed: 1.05,
      numSteps: 8,
      extra: { lang: 'es' },
    });
  });

  function montar(raiz: string, fallaSupertonic: boolean) {
    const usados: string[] = [];
    let respaldos = 0;
    const respaldo: Tts = {
      name: 'sapi',
      speak: async (t) => {
        respaldos++;
        return audio(t);
      },
    };
    const tts = createTtsConVozLocal(
      { PA_TTS_LOCAL: 'supertonic' },
      {
        respaldo,
        raiz,
        plataforma: 'win32',
        descarga: { fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch },
        crearLocal: (modelo) => ({
          name: 'sherpa',
          speak: async (t) => {
            const quien = modelo.supertonic ? 'supertonic' : modelo.kokoro ? 'kokoro' : 'vits';
            if (quien === 'supertonic' && fallaSupertonic) throw new Error('onnx roto');
            usados.push(quien);
            return audio(t);
          },
        }),
      },
    );
    return { tts, usados, respaldos: () => respaldos };
  }

  it('mientras Supertonic se descarga habla Kokoro (la que ya tiene el PC)', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'st3-'));
    colocar(raiz, VOCES_LOCALES.kokoro as VozLocal);
    colocar(raiz, VOCES_LOCALES.sharvard as VozLocal);
    const m = montar(raiz, false);
    await m.tts.speak('Hola');
    expect(m.usados).toEqual(['kokoro']);
    expect(m.respaldos()).toBe(0);
  });

  it('si Supertonic falla, responde Kokoro y no la voz del sistema', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'st3-'));
    colocar(raiz, supertonic());
    colocar(raiz, VOCES_LOCALES.kokoro as VozLocal);
    const m = montar(raiz, true);
    await m.tts.speak('Hola');
    expect(m.usados).toEqual(['kokoro']);
    expect(m.respaldos()).toBe(0);
  });

  it('ya descargada, habla Supertonic', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'st3-'));
    colocar(raiz, supertonic());
    const m = montar(raiz, false);
    await m.tts.speak('Hola');
    expect(m.usados).toEqual(['supertonic']);
  });
});

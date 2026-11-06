import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';
import { describe, expect, it, vi } from 'vitest';

// El PC no debe arrancar ffmpeg para una nota de /voz: si lo intenta, el test lo ve.
const spawns = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      spawns.n++;
      return real.spawn(...args);
    },
  };
});

import { looksSilent } from '../src/voice/audio.js';
import { decodeForWhisper } from '../src/voice/decode.js';
import { cargarSherpaCon } from '../src/voice/sherpa.js';
import { motivoStt } from '../src/voice/stt.js';
import { renderVozPage } from '../src/webui/voz-page.js';
import { VOZ_WAV_JS } from '../src/webui/voz-wav.js';

/** «Hola.» en castellano grabado como lo graba el iPhone: mp4 fragmentado, AAC-LC, 48 kHz. */
const M4A = readFileSync(new URL('./fixtures/voz/hola-iphone.m4a', import.meta.url));

const BIN =
  typeof ffmpegStatic === 'string' && existsSync(ffmpegStatic)
    ? ffmpegStatic
    : spawnSync('ffmpeg', ['-version']).status === 0
      ? 'ffmpeg'
      : null;
const binOk = !!BIN && spawnSync(BIN, ['-version']).status === 0;

/** Lo que hace `decodeAudioData` en el iPhone: el AAC a float a 48 kHz (aquí con ffmpeg). */
function comoDecodeAudioData(m4a: Buffer): Float32Array {
  const r = spawnSync(
    BIN as string,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { input: m4a, maxBuffer: 1 << 24 },
  );
  if (r.status !== 0) throw new Error(String(r.stderr));
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

describe('voz 3: «hola» desde el iPhone se transcribe sin ffmpeg en el PC', () => {
  it.skipIf(!binOk)(
    'el m4a del iPhone pasa a WAV en la página y el PC lo lee en JavaScript',
    async () => {
      const wavMono16k = new Function(`${VOZ_WAV_JS}; return wavMono16k;`)() as (
        canales: Float32Array[],
        rate: number,
      ) => ArrayBuffer;
      const pcm48 = comoDecodeAudioData(M4A);
      expect(pcm48.length / 48_000).toBeGreaterThan(0.5);
      const wav = Buffer.from(wavMono16k([pcm48], 48_000));
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');

      spawns.n = 0;
      const dec = await decodeForWhisper(wav, 'audio/wav');
      expect(spawns.n).toBe(0);
      expect(dec.sampleRate).toBe(16_000);
      expect(Math.abs(dec.samples.length / 16_000 - pcm48.length / 48_000)).toBeLessThan(0.01);
      expect(looksSilent(dec.samples)).toBe(false);
      // La misma voz: cada muestra a 16 kHz cae sobre la de 48 kHz (salvo el redondeo a 16 bits).
      let err = 0;
      for (let i = 0; i < dec.samples.length; i++) {
        err = Math.max(err, Math.abs((dec.samples[i] ?? 0) - (pcm48[i * 3] ?? 0)));
      }
      expect(err).toBeLessThan(0.001);
    },
  );

  it('la página /voz convierte la grabación a WAV antes de mandarla', () => {
    const html = renderVozPage();
    expect(html).toContain('function wavMono16k(');
    expect(html).toContain('decodeAudioData');
    expect(html).toMatch(/mandar\(wav, 'audio\/wav'\)/);
    // Si el navegador no sabe decodificar, va lo grabado tal cual (ffmpeg en el PC).
    expect(html).toMatch(/mandar\(audio, tipo/);
  });

  it('el error genérico dice el motivo real en una frase corta', () => {
    expect(motivoStt('no pude ejecutar ffmpeg: spawn EPERM')).toMatch(/antivirus/);
    expect(motivoStt('ffmpeg tardo mas de 60000ms en leer el audio')).toMatch(/ffmpeg tardó/);
    expect(motivoStt('whisper did not finish transcribing within 300s')).toMatch(/tardó demasiado/);
    expect(
      motivoStt('The requested API version [24] is not available, only API versions [1, 22]'),
    ).toMatch(/onnxruntime; reinicia/);
    expect(motivoStt('std::bad_alloc')).toMatch(/sin memoria/);
    const raro = motivoStt('Protobuf parsing failed at C:\\Users\\Nico\\models\\enc.onnx');
    expect(raro).toBe('fallo de whisper: Protobuf parsing failed');
  });

  it('en Windows onnxruntime-node se carga antes que sherpa (si no, whisper hereda su DLL vieja)', () => {
    const orden: string[] = [];
    const requerir = (id: string) => {
      orden.push(id);
      return {};
    };
    cargarSherpaCon(requerir, 'win32');
    expect(orden).toEqual(['onnxruntime-node', 'sherpa-onnx-node']);
    orden.length = 0;
    cargarSherpaCon(requerir, 'linux');
    expect(orden).toEqual(['sherpa-onnx-node']);
  });
});

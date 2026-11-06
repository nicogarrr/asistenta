import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { cargarSherpaCon, olvidarPrecargaOrt, precargarOnnxRuntime } from '../src/voice/sherpa.js';

// Windows: sherpa-onnx-node 1.13.8 trae onnxruntime 1.28.2 y whisper usa onnxruntime-node
// 1.30.0; las dos son «onnxruntime.dll» y gana la primera que se carga. Ahora Asistenta carga
// onnxruntime-node al arrancar (una vez) y si algo no carga lo dice claro.

afterEach(() => olvidarPrecargaOrt());

describe('Windows: orden fijo de onnxruntime al arrancar', () => {
  it('serve y chat cargan onnxruntime-node lo primero', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    for (const fn of ['async function serveCommand(', 'async function chatCommand(']) {
      const cuerpo = cli.slice(cli.indexOf(fn), cli.indexOf(fn) + 400);
      expect(cuerpo.indexOf('precargarOnnxRuntime();')).toBeGreaterThan(0);
      expect(cuerpo.indexOf('precargarOnnxRuntime();')).toBeLessThan(
        cuerpo.indexOf('ensureDirs()'),
      );
    }
  });

  it('carga onnxruntime-node una sola vez y solo en Windows', () => {
    const pedidos: string[] = [];
    const requerir = (id: string) => {
      pedidos.push(id);
      return {};
    };
    expect(precargarOnnxRuntime(requerir, 'linux')).toEqual({ ok: true });
    expect(pedidos).toEqual([]);
    olvidarPrecargaOrt();
    expect(precargarOnnxRuntime(requerir, 'win32')).toEqual({ ok: true });
    precargarOnnxRuntime(requerir, 'win32');
    expect(pedidos).toEqual(['onnxruntime-node']);
  });

  it('si onnxruntime-node no carga, lo dice claro en vez de callarlo', () => {
    const avisos: string[] = [];
    const r = precargarOnnxRuntime(
      () => {
        throw new Error(
          'The specified module could not be found.\n\\\\?\\C:\\x\\onnxruntime_binding.node',
        );
      },
      'win32',
      (t) => avisos.push(t),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain(
      'No pude cargar onnxruntime-node (The specified module could not be found.)',
    );
    expect(r.error).toContain('npm ci');
    expect(avisos).toEqual([r.error]);
  });

  it('si sherpa-onnx-node no carga, el error dice qué es y qué hacer', () => {
    const requerir = (id: string) => {
      if (id === 'sherpa-onnx-node') throw new Error('DLL load failed');
      return {};
    };
    expect(() => cargarSherpaCon(requerir, 'win32')).toThrow(
      /No pude cargar la voz local \(sherpa-onnx-node: DLL load failed\).*npm ci/,
    );
  });
});

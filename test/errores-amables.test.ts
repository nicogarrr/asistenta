import { describe, expect, it } from 'vitest';
import { failedReply } from '../src/cli.js';

describe('errores de cámara, micro, audio y palabra en castellano y sin texto técnico', () => {
  it('un error en castellano se conserva tras el qué', () => {
    expect(
      failedReply('No he podido usar la cámara', new Error('No hay ninguna cámara conectada')),
    ).toBe('No he podido usar la cámara: No hay ninguna cámara conectada');
  });

  it('salida técnica (ffmpeg, rutas, JSON, varias líneas) no llega al chat', () => {
    const err = new Error(
      '[dshow @ 000001] Could not enumerate video devices (or none found).\nC:\\Users\\nico\\ffmpeg.exe exited 1',
    );
    const r = failedReply('No he podido usar la cámara', err);
    expect(r).not.toMatch(/dshow|ffmpeg|Users/);
    expect(r).toBe(
      'No he podido usar la cámara (error interno). Prueba otra vez; si se repite, mira /estado.',
    );
  });

  it('programa que falta en el PC: lo dice claro', () => {
    const err = Object.assign(new Error('spawn sox ENOENT'), { code: 'ENOENT' });
    expect(failedReply('No he podido grabar el micrófono', err)).toBe(
      'No he podido grabar el micrófono: no encuentro «sox» instalado en el PC.',
    );
  });

  it('un tiempo agotado usa el aviso amable, con el qué delante', () => {
    expect(failedReply('No he podido reproducir el audio', new Error('ETIMEDOUT'))).toBe(
      'No he podido reproducir el audio. Ha tardado demasiado y lo he cortado. Prueba otra vez en un momento.',
    );
  });

  it('valores que no son Error tampoco salen crudos', () => {
    expect(failedReply('No pude resumir el historial', { a: 1 })).toContain('(error interno)');
    expect(failedReply('No la he anotado', 'idea vacía')).toBe('No la he anotado: idea vacía');
  });
});

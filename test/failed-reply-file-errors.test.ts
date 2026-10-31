import { describe, expect, it } from 'vitest';
import { failedReply } from '../src/cli.js';

/** Una nota de voz que falla por un archivo no debe enseñar «ENOENT: …» ni la ruta entera. */
describe('failedReply con errores de archivo', () => {
  const what = 'No he entendido la nota de voz';

  it('ENOENT: dice qué archivo falta, sin texto técnico ni ruta', () => {
    const out = failedReply(
      what,
      new Error("ENOENT: no such file or directory, open 'C:\\Users\\nico\\models\\encoder.onnx'"),
    );
    expect(out).toBe('No he entendido la nota de voz: falta el archivo «encoder.onnx» en el PC.');
  });

  it('EPERM / EACCES / EBUSY: en castellano, solo el nombre', () => {
    for (const code of ['EPERM', 'EACCES']) {
      const out = failedReply(
        what,
        new Error(`${code}: operation not permitted, open '/tmp/a/nota.ogg'`),
      );
      expect(out).toContain('«nota.ogg»');
      expect(out).not.toMatch(/EPERM|EACCES|\/tmp/);
    }
    const busy = failedReply(
      what,
      new Error("EBUSY: resource busy or locked, open 'C:\\x\\y.wav'"),
    );
    expect(busy).toContain('en uso por otro programa');
  });

  it('lo demás sigue igual', () => {
    expect(failedReply(what, new Error('spawn ffmpeg ENOENT'))).toContain('no encuentro «ffmpeg»');
  });
});

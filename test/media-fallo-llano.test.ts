import { describe, expect, it } from 'vitest';
import { playbackFailureText } from '../src/tools/media.js';

describe('media: el fallo de reproducción sale en castellano llano', () => {
  it('no repite el error crudo del sistema', () => {
    const enoent = Object.assign(new Error('spawn C:\\ffmpeg\\ffplay.exe ENOENT'), {
      code: 'ENOENT',
    });
    expect(playbackFailureText(enoent)).toBe(
      'No he podido reproducirlo: falta el programa de audio en el PC.',
    );
    expect(playbackFailureText(new Error('fetch failed'))).toBe(
      'No he podido reproducirlo por un fallo del reproductor.',
    );
    for (const err of [
      enoent,
      new Error('EPERM: operation not permitted'),
      new Error('fetch failed'),
    ]) {
      expect(playbackFailureText(err)).not.toMatch(/ENOENT|EPERM|fetch failed|ffplay|C:\\/);
    }
  });
});

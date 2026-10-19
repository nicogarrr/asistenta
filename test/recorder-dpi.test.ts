import { describe, expect, it } from 'vitest';
import { ffmpegEnv } from '../src/screen/recorder.js';

describe('ffmpegEnv', () => {
  it('starts ffmpeg DPI aware on Windows so gdigrab records the whole scaled desktop', () => {
    const env = ffmpegEnv('win32', { PATH: 'x' });
    expect(env.__COMPAT_LAYER).toBe('HighDpiAware');
    expect(env.PATH).toBe('x');
  });

  it('keeps flags the user already set and does not duplicate its own', () => {
    expect(ffmpegEnv('win32', { __COMPAT_LAYER: 'RunAsInvoker' }).__COMPAT_LAYER).toBe(
      'RunAsInvoker HighDpiAware',
    );
    const base = { __COMPAT_LAYER: 'HighDpiAware' };
    expect(ffmpegEnv('win32', base)).toBe(base);
  });

  it('leaves other platforms alone', () => {
    const base = { PATH: 'x' };
    expect(ffmpegEnv('linux', base)).toBe(base);
  });
});

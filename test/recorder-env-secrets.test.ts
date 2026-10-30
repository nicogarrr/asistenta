import { describe, expect, it } from 'vitest';
import { ffmpegEnv, isSecretEnvName } from '../src/screen/recorder.js';

describe('ffmpegEnv no pasa secretos al ffmpeg que graba la pantalla', () => {
  const base = {
    PATH: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    SESSIONNAME: 'Console',
    USERPROFILE: 'C:\\Users\\nico',
    TELEGRAM_BOT_TOKEN: '123:abc',
    OPENAI_API_KEY: 'sk-x',
    ANTHROPIC_APIKEY: 'k',
    PA_VAULT_PASSWORD: 'p',
    GITHUB_SECRET: 's',
  };

  it('quita tokens, claves y contraseñas en Windows y conserva las del sistema', () => {
    const env = ffmpegEnv('win32', base);
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_APIKEY).toBeUndefined();
    expect(env.PA_VAULT_PASSWORD).toBeUndefined();
    expect(env.GITHUB_SECRET).toBeUndefined();
    expect(env.PATH).toBe('C:\\Windows');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.TEMP).toBe('C:\\Temp');
    expect(env.SESSIONNAME).toBe('Console');
    expect(env.USERPROFILE).toBe('C:\\Users\\nico');
    expect(env.__COMPAT_LAYER).toBe('HighDpiAware');
  });

  it('también fuera de Windows, sin tocar el objeto original', () => {
    const env = ffmpegEnv('linux', base);
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('C:\\Windows');
    expect(base.TELEGRAM_BOT_TOKEN).toBe('123:abc');
  });

  it('las variables de sistema de Windows no cuentan como secretas (caracterización)', () => {
    for (const name of [
      'PATH',
      'PATHEXT',
      'SystemRoot',
      'windir',
      'ComSpec',
      'TEMP',
      'TMP',
      'APPDATA',
      'LOCALAPPDATA',
      'SESSIONNAME',
      'PROCESSOR_ARCHITECTURE',
      'NUMBER_OF_PROCESSORS',
      'USERPROFILE',
      'HOMEDRIVE',
      '__COMPAT_LAYER',
    ])
      expect(isSecretEnvName(name)).toBe(false);
  });
});

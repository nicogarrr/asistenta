import { describe, expect, it, vi } from 'vitest';
import { cuentasCommand } from '../src/credentials/export.js';
import { saveAccount, type VaultOps } from '../src/credentials/store.js';

vi.mock('../src/voice/decode.js', () => ({
  ffmpegDecoderAvailable: () => true,
  decodeAudioWithFfmpeg: async () => ({ sampleRate: 16000, samples: new Float32Array(16000) }),
}));
vi.mock('../src/voice/speaker-verify.js', () => ({
  SPK_SAMPLE_RATE: 16000,
  speakerGateConfigFromEnv: () => ({}),
  SpeakerVerifier: {
    load: async () => ({
      enroll: async (name: string) => ({ name, utterances: 1, enrolledAt: '2026-11-02' }),
      list: () => [{ name: 'nico', utterances: 1, enrolledAt: '2026-11-02' }],
    }),
  },
}));
vi.mock('node:fs/promises', async (orig) => ({
  ...(await orig<typeof import('node:fs/promises')>()),
  readFile: async () => Buffer.from('x'),
}));

function memVault(): VaultOps {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => map.delete(k),
    list: async () => [...map.keys()],
  };
}

// asis-bugs-20: con una sola cuenta o una sola muestra de voz, la CLI decía
// «Exportadas 1 cuentas» y «(1 muestras)».
describe('pa cuentas exportar y pa voice: singulares', () => {
  it('una cuenta → «Exportada 1 cuenta»', async () => {
    const v = memVault();
    await saveAccount({ site: 'wallapop.es', username: 'nico@gmail.com' }, v);
    const outs: string[] = [];
    const rc = await cuentasCommand(['exportar', 'bitwarden', '/tmp/no-se-escribe.json'], {
      vault: v,
      out: (s) => outs.push(s),
      ask: async () => 'EXPORTAR',
      isTty: true,
      write: () => {},
    });
    expect(rc).toBe(0);
    expect(outs.join('\n')).toContain('Exportada 1 cuenta a /tmp/no-se-escribe.json.');
  });

  it('una muestra de voz → «(1 muestra)»', async () => {
    const { voiceCommand } = await import('../src/voice/voice-cli.js');
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      written.push(String(s));
      return true;
    });
    try {
      expect(await voiceCommand(['enroll', 'nico', 'a.ogg'])).toBe(0);
      expect(await voiceCommand(['list'])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const text = written.join('');
    expect(text).toContain('Voz enrolada: nico (1 muestra).');
    expect(text).toContain('nico\t1 muestra\t');
    expect(text).not.toContain('1 muestras');
  });
});

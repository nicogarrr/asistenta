import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ cmd: string; env: NodeJS.ProcessEnv | undefined }> = [];

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const fakeChild = () => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => true, end: () => undefined, on: () => undefined };
    child.kill = () => true;
    return child;
  };
  return {
    ...real,
    execFile: (cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }, cb: unknown) => {
      calls.push({ cmd, env: opts?.env });
      if (typeof cb === 'function') cb(null, '', '');
      return fakeChild();
    },
    spawn: (cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ cmd, env: opts?.env });
      return fakeChild();
    },
  };
});

const SECRETS = {
  TELEGRAM_BOT_TOKEN: 'tg-secreto',
  OPENAI_API_KEY: 'sk-secreto',
  PA_MAIL_PASSWORD: 'correo-secreto',
};

function expectClean(env: NodeJS.ProcessEnv | undefined): void {
  // Sin `env` el hijo hereda process.env entero, con los secretos.
  expect(env).toBeDefined();
  for (const name of Object.keys(SECRETS)) expect(env).not.toHaveProperty(name);
  expect(env?.PATH).toBe(process.env.PATH);
}

describe('procesos hijos sin credenciales del daemon', () => {
  beforeEach(() => {
    calls.length = 0;
    Object.assign(process.env, SECRETS);
  });
  afterEach(() => {
    for (const name of Object.keys(SECRETS)) delete process.env[name];
  });

  it('pa tv mac auto: ping y arp sin tokens', async () => {
    const { readNeighborMac } = await import('../src/tv/neighbor-mac.js');
    await readNeighborMac('192.168.1.20', undefined, 'linux');
    expect(calls.map((c) => c.cmd)).toEqual(['ping', 'ip']);
    for (const c of calls) expectClean(c.env);
  });

  it('conversor de libros sin tokens', async () => {
    const { findConverter } = await import('../src/books/convert.js');
    await findConverter(undefined, { PATH: process.env.PATH });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expectClean(c.env);
  });

  it('altavoz: conserva PA_SPK_FILE y quita los tokens', async () => {
    const { createMciSpeaker } = await import('../src/voice/speaker.js');
    createMciSpeaker().play('C:\\voz\\a.wav');
    expect(calls).toHaveLength(1);
    expectClean(calls[0]?.env);
    expect(calls[0]?.env?.PA_SPK_FILE).toBe('C:\\voz\\a.wav');
  });

  it('childEnv quita solo nombres de credencial y añade los del hijo', async () => {
    const { childEnv } = await import('../src/child-env.js');
    const env = childEnv(
      { PA_X: '1' },
      { PATH: '/bin', SystemRoot: 'C:\\Windows', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's' },
    );
    expect(env).toEqual({ PATH: '/bin', SystemRoot: 'C:\\Windows', PA_X: '1' });
  });

  it('cada hijo de voz, descargas, OCR local, tele y libros pasa childEnv()', () => {
    const files = [
      'src/tv/neighbor-mac.ts',
      'src/voice/tts.ts',
      'src/voice/wake.ts',
      'src/voice/speaker.ts',
      'src/voice/piper.ts',
      'src/voice/decode.ts',
      'src/media/download.ts',
      'src/books/convert.ts',
      'src/tools/ocr-local.ts',
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const spawns = src.match(/\b(?:spawn|execFile|execFileAsync)\(/g)?.length ?? 0;
      const clean = src.match(/\bchildEnv\(/g)?.length ?? 0;
      expect({ f, missing: spawns - clean }).toEqual({ f, missing: 0 });
      expect(src).not.toMatch(/\.\.\.process\.env\b/);
    }
  });
});

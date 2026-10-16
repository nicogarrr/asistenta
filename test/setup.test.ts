import { expect, it, vi } from 'vitest';
import { type SetupDeps, setupCommand } from '../src/setup.js';

function harness(answers: string[], options: Partial<SetupDeps> = {}) {
  const output: string[] = [];
  const question = vi.fn(async () => answers.shift() ?? 'no');
  const set = vi.fn(async (_key: string, _value: string) => {});
  const deps: SetupDeps = {
    question,
    write: (s) => output.push(s),
    get: async () => undefined,
    set,
    init: vi.fn(async () => {}),
    backend: () => 'portable',
    prepare: vi.fn(),
    config: () => ({ model: 'synthetic-model', provider: 'synthetic-provider' }),
    nodeMajor: 24,
    built: true,
    ...options,
  };
  return { deps, output, question, set };
}
it('refuses arguments before touching vault or state', async () => {
  const h = harness([]);
  expect(await setupCommand(['secret-in-args'], h.deps)).toBe(2);
  expect(h.deps.prepare).not.toHaveBeenCalled();
  expect(h.output.join('')).not.toContain('secret-in-args');
});
it.each([{ nodeMajor: 22 }, { built: false }])(
  'refuses missing prerequisites before prompting',
  async (options) => {
    const h = harness([], options);
    expect(await setupCommand([], h.deps)).toBe(1);
    expect(h.question).not.toHaveBeenCalled();
    expect(h.deps.prepare).not.toHaveBeenCalled();
  },
);
it('cancel does not initialize or read vault', async () => {
  const get = vi.fn(async () => undefined);
  const h = harness(['no'], { get });
  expect(await setupCommand([], h.deps)).toBe(0);
  expect(get).not.toHaveBeenCalled();
  expect(h.deps.prepare).not.toHaveBeenCalled();
});
it('preserves existing values without printing them or asking replacement', async () => {
  const h = harness(['sí'], { get: async () => 'private-current' });
  expect(await setupCommand([], h.deps)).toBe(0);
  expect(h.set).not.toHaveBeenCalled();
  expect(h.question).toHaveBeenCalledTimes(1);
  expect(h.output.join('')).not.toContain('private-current');
});
it('saves only fields individually approved and hides token/key prompts', async () => {
  const token = '123456:abcdefghijklmnopqrstuv';
  const key = 'private-provider-key';
  const h = harness(['sí', 'sí', token, 'sí', '123,456', 'sí', key]);
  expect(await setupCommand([], h.deps)).toBe(0);
  expect(h.set.mock.calls).toEqual([
    ['telegram:botToken', token],
    ['telegram:allowedUserIds', '123,456'],
    ['provider:apiKey', key],
  ]);
  expect(h.output.join('')).not.toContain(token);
  expect(h.output.join('')).not.toContain(key);
  expect(h.question.mock.calls[2]).toEqual(['Token de tu bot creado en BotFather', true]);
});
it.each(['@username', '0', '-1', '1e3', '9007199254740992', '123,'])(
  'rejects invalid Telegram user identity %s',
  async (invalid) => {
    const h = harness(['sí', 'no', 'sí', invalid]);
    expect(await setupCommand([], h.deps)).toBe(1);
    expect(h.set).not.toHaveBeenCalled();
  },
);
it('reports skipped fields as pending rather than fully configured', async () => {
  const h = harness(['sí', 'no', 'no', 'no']);
  expect(await setupCommand([], h.deps)).toBe(1);
  expect(h.output.join('')).toContain('no se afirma configuración completa');
  expect(h.set).not.toHaveBeenCalled();
});
it('never prints a secret-bearing vault error or falls back to another backend', async () => {
  const init = vi.fn(async () => {
    throw new Error('private-vault-error');
  });
  const h = harness(['sí', 'sí'], {
    get: async () => {
      throw new Error('private-vault-error');
    },
    init,
    backend: () => 'dpapi',
  });
  expect(await setupCommand([], h.deps)).toBe(1);
  expect(init).toHaveBeenCalledOnce();
  expect(h.output.join('')).not.toContain('private-vault-error');
  expect(h.output.join('')).toContain('no se cambia de backend');
});
it('skips external API key collection with a local provider', async () => {
  const h = harness(['sí', 'no', 'no'], {
    config: () => ({ model: 'synthetic', provider: 'opencode-local' }),
  });
  expect(await setupCommand([], h.deps)).toBe(1);
  expect(h.question).toHaveBeenCalledTimes(3);
  expect(h.output.join('')).toContain('no pide ni almacena una clave externa');
});
it('does not leak invalid configuration values', async () => {
  const h = harness(['sí'], {
    config: () => {
      throw new Error('env-private-value');
    },
  });
  expect(await setupCommand([], h.deps)).toBe(1);
  expect(h.output.join('')).not.toContain('env-private-value');
  expect(h.deps.prepare).not.toHaveBeenCalled();
});
it('fails closed when existing daemon or unsafe state prevents setup', async () => {
  const h = harness(['sí'], {
    prepare: () => {
      throw new Error('private-path');
    },
  });
  expect(await setupCommand([], h.deps)).toBe(1);
  expect(h.set).not.toHaveBeenCalled();
  expect(h.output.join('')).not.toContain('private-path');
});

import { beforeEach, expect, it, vi } from 'vitest';
import { type SetupDeps, setupCommand } from '../src/setup.js';

let answers: string[];
let committed: Record<string, string> | undefined;
let output: string;
let deps: SetupDeps;
beforeEach(() => {
  answers = [];
  committed = undefined;
  output = '';
  deps = {
    question: vi.fn(async () => answers.shift() ?? ''),
    write: (s) => {
      output += s;
    },
    inspect: vi.fn(),
    acquire: vi.fn(() => ({ assert: vi.fn(), release: vi.fn() })),
    configure: vi.fn(
      async (keys: readonly string[], review: Parameters<SetupDeps['configure']>[1]) => {
        committed = await review(keys.map((key) => ({ key, source: 'missing' as const })));
        return committed !== undefined;
      },
    ),
    config: () => ({ provider: 'opencode' }),
    prerequisites: () => true,
    platform: 'linux',
    desktop: false,
    interactive: true,
    nodeMajor: 24,
    built: true,
  };
});
it('Windows is guide only before inspect/config/vault/prompts', async () => {
  expect(await setupCommand([], { ...deps, platform: 'win32' })).toBe(2);
  expect(deps.inspect).not.toHaveBeenCalled();
  expect(deps.acquire).not.toHaveBeenCalled();
  expect(deps.configure).not.toHaveBeenCalled();
  expect(deps.question).not.toHaveBeenCalled();
});
it.each([
  { nodeMajor: 23 },
  { built: false },
  { prerequisites: () => false },
  { interactive: false },
  { desktop: true },
])('prerequisites fail before ownership %j', async (flag) => {
  expect(await setupCommand([], { ...deps, ...flag })).toBe(1);
  expect(deps.acquire).not.toHaveBeenCalled();
  expect(deps.configure).not.toHaveBeenCalled();
});
it('arguments are refused without echo', async () => {
  expect(await setupCommand(['SYNTHETIC-PRIVATE'], deps)).toBe(2);
  expect(output).not.toContain('SYNTHETIC-PRIVATE');
  expect(deps.inspect).not.toHaveBeenCalled();
});
it('ambiguous legacy state is rejected before config or questions', async () => {
  deps.inspect = () => {
    throw Error('private-internal');
  };
  deps.config = vi.fn();
  expect(await setupCommand([], deps)).toBe(1);
  expect(deps.config).not.toHaveBeenCalled();
  expect(deps.question).not.toHaveBeenCalled();
  expect(output).not.toContain('private-internal');
});
it('initial cancel acquires no ownership', async () => {
  answers = ['no'];
  expect(await setupCommand([], deps)).toBe(0);
  expect(deps.acquire).not.toHaveBeenCalled();
});
it('initial EOF is caught without effects or internal errors', async () => {
  deps.question = async () => {
    throw Error('private-internal');
  };
  expect(await setupCommand([], deps)).toBe(1);
  expect(deps.acquire).not.toHaveBeenCalled();
  expect(output).not.toContain('private-internal');
});
it('commits once only after final named summary and yes without values', async () => {
  answers = [
    'sí',
    'sí',
    '12345:abcdefghijklmnopqrstuv',
    'sí',
    '123,456',
    'sí',
    'synthetic-key',
    'sí',
  ];
  expect(await setupCommand([], deps)).toBe(0);
  expect(committed).toEqual({
    'telegram:botToken': '12345:abcdefghijklmnopqrstuv',
    'telegram:allowedUserIds': '123,456',
    'provider:apiKey': 'synthetic-key',
  });
  expect(deps.configure).toHaveBeenCalledOnce();
  expect(output).toContain(
    'Cambios propuestos solo en: telegram:botToken, telegram:allowedUserIds, provider:apiKey',
  );
  expect(output).not.toContain('synthetic-key');
  expect(output).not.toContain('abcdefghijklmnopqrstuv');
});
it('final cancellation commits nothing', async () => {
  answers = ['sí', 'sí', '12345:abcdefghijklmnopqrstuv', '', '', 'no'];
  expect(await setupCommand([], deps)).toBe(1);
  expect(committed).toBeUndefined();
  expect(output).toContain('Cancelado');
});
it('environment fields are not offered and blank file answer conserves', async () => {
  deps.configure = vi.fn(async (_keys, review) => {
    committed = await review([
      { key: 'telegram:botToken', source: 'environment' },
      { key: 'telegram:allowedUserIds', source: 'file' },
      { key: 'provider:apiKey', source: 'file' },
    ]);
    return Boolean(committed);
  });
  answers = ['sí', '', ''];
  expect(await setupCommand([], deps)).toBe(0);
  expect(committed).toBeUndefined();
  expect(deps.question).toHaveBeenCalledTimes(3);
});
it('existing fields need explicit reemplazar; blank replacement conserves', async () => {
  deps.configure = vi.fn(async (_keys, review) => {
    committed = await review([{ key: 'provider:apiKey', source: 'file' }]);
    return Boolean(committed);
  });
  answers = ['sí', 'reemplazar', ''];
  expect(await setupCommand([], deps)).toBe(0);
  expect(committed).toBeUndefined();
});
it('opencode-local does not request an API key', async () => {
  deps.config = () => ({ provider: 'opencode-local' });
  answers = ['sí', '', ''];
  expect(await setupCommand([], deps)).toBe(1);
  expect(deps.configure).toHaveBeenCalledWith(
    ['telegram:botToken', 'telegram:allowedUserIds'],
    expect.any(Function),
  );
});
it('prompt error releases ownership and no commit', async () => {
  const release = vi.fn();
  deps.acquire = () => ({ assert: vi.fn(), release });
  let n = 0;
  deps.question = async () => {
    if (n++ === 0) return 'sí';
    throw Error('synthetic-secret');
  };
  expect(await setupCommand([], deps)).toBe(1);
  expect(release).toHaveBeenCalledOnce();
  expect(committed).toBeUndefined();
  expect(output).not.toContain('synthetic-secret');
});
it('lost daemon ownership aborts before commit', async () => {
  deps.acquire = () => ({
    assert: () => {
      throw Error('lost');
    },
    release: vi.fn(),
  });
  answers = ['sí'];
  expect(await setupCommand([], deps)).toBe(1);
  expect(committed).toBeUndefined();
});
it('unsafe ID rejects the entire proposal', async () => {
  answers = ['sí', 'sí', '12345:abcdefghijklmnopqrstuv', 'sí', '9007199254740992'];
  expect(await setupCommand([], deps)).toBe(1);
  expect(committed).toBeUndefined();
});

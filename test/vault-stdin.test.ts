import { PassThrough, Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { readSecretStdin, setVaultFromStdin } from '../src/vault-stdin.js';

it.each(['private-value', 'private-value\n', 'private-value\r\n'])(
  'reads a single private line without echo',
  async (value) => {
    const save = vi.fn(async () => {});
    await setVaultFromStdin(['provider:apiKey'], Readable.from([value]), save);
    expect(save).toHaveBeenCalledWith('provider:apiKey', 'private-value');
  },
);
it.each(['', '\n', 'first\nsecond', 'first\rsecond', 'private\0value', 'x'.repeat(16385)])(
  'rejects invalid secret without quoting it',
  async (value) => {
    const save = vi.fn(async () => {});
    await expect(
      setVaultFromStdin(['provider:apiKey'], Readable.from([value]), save),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  },
);
it('refuses an echoing terminal before consuming any bytes', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  const read = vi.spyOn(input, Symbol.asyncIterator);
  await expect(readSecretStdin(input)).rejects.toThrow('No pegues');
  expect(read).not.toHaveBeenCalled();
});
it.each([
  { args: [] },
  { args: ['--bad'] },
  { args: ['provider:apiKey', 'extra'] },
  { args: ['a'.repeat(129)] },
])('rejects invalid arguments before reading', async ({ args }) => {
  const input = new PassThrough();
  const read = vi.spyOn(input, Symbol.asyncIterator);
  await expect(setVaultFromStdin(args, input, async () => {})).rejects.toThrow('uso:');
  expect(read).not.toHaveBeenCalled();
});
it('never propagates a secret-bearing stream error', async () => {
  const input = new PassThrough();
  const result = readSecretStdin(input);
  input.destroy(new Error('private-stream-secret'));
  await expect(result).rejects.toThrow('No se pudo leer');
  await expect(result).rejects.not.toThrow('private-stream-secret');
});
it('never propagates a secret-bearing vault error', async () => {
  await expect(
    setVaultFromStdin(['key'], Readable.from(['private']), async () => {
      throw new Error('private-vault-secret');
    }),
  ).rejects.toThrow('No se pudo guardar');
});
it('bounds a pipe that never ends', async () => {
  const input = new PassThrough();
  input.write('private');
  await expect(readSecretStdin(input, 10)).rejects.toThrow('no terminó');
  expect(input.destroyed).toBe(true);
});

it('rejects invalid UTF-8 instead of silently storing replacement characters', async () => {
  await expect(readSecretStdin(Readable.from([Buffer.from([0xff, 0xfe])]))).rejects.toThrow(
    'No se pudo leer',
  );
});

it.each(['La entrada secreta private-forged', 'Se requiere private-forged'])(
  'does not trust a stream error that imitates our validation message',
  async (message) => {
    const input = new PassThrough();
    const result = readSecretStdin(input);
    input.destroy(new Error(message));
    await expect(result).rejects.toThrow('No se pudo leer');
    await expect(result).rejects.not.toThrow('private-forged');
  },
);

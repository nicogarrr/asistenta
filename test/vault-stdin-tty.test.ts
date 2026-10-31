import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { readSecretStdin } from '../src/vault-stdin.js';

/** `pa vault set-stdin` abierto a mano en la consola de Windows: pide la clave sin que se vea. */
type FakeTty = PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => FakeTty };
function fakeTty(): { input: FakeTty; raw: boolean[] } {
  const raw: boolean[] = [];
  const input = new PassThrough() as FakeTty;
  input.isTTY = true;
  input.setRawMode = (on: boolean) => {
    raw.push(on);
    return input;
  };
  return { input, raw };
}
const sink = () => {
  const out: string[] = [];
  return { out, write: (s: string) => void out.push(s) };
};

it('terminal: pide la clave sin eco y la lee hasta Enter', async () => {
  const { input, raw } = fakeTty();
  const o = sink();
  const p = readSecretStdin(input, 5_000, o.write);
  input.write('sk-pri');
  input.write('vado\r');
  await expect(p).resolves.toBe('sk-privado');
  expect(raw).toEqual([true, false]);
  expect(o.out.join('')).toMatch(/no se verá/);
  expect(o.out.join('')).not.toContain('sk-');
});

it('terminal: el retroceso borra y Ctrl+C cancela sin guardar nada', async () => {
  const a = fakeTty();
  const p1 = readSecretStdin(a.input, 5_000, () => {});
  a.input.write('abX\x7fc\n');
  await expect(p1).resolves.toBe('abc');

  const b = fakeTty();
  const p2 = readSecretStdin(b.input, 5_000, () => {});
  b.input.write('secreto\x03');
  await expect(p2).rejects.toThrow('Cancelado');
  expect(b.raw.at(-1)).toBe(false);
});

it('terminal: Enter sin nada no guarda una clave vacía', async () => {
  const { input } = fakeTty();
  const p = readSecretStdin(input, 5_000, () => {});
  input.write('\r');
  await expect(p).rejects.toThrow('no vacío');
});

it('terminal sin modo oculto: sigue negándose (nunca con eco)', async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  const read = vi.spyOn(input, Symbol.asyncIterator);
  await expect(readSecretStdin(input)).rejects.toThrow('No pegues');
  expect(read).not.toHaveBeenCalled();
});

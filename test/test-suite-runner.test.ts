import { describe, expect, it, vi } from 'vitest';
// El runner es Node ESM puro y no forma parte del build de producción.
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { RESOURCE_TESTS, runSuite } from '../scripts/run-tests.mjs';

describe('suite en dos fases, sin pérdidas de cobertura', () => {
  it('excluye exactamente los dos ficheros de general y los ejecuta serial después', () => {
    const launch = vi.fn((_executable: string, _args: string[], _options: unknown) => ({
      status: 0,
    }));
    expect(runSuite([], launch)).toBe(0);
    expect(launch).toHaveBeenCalledTimes(2);
    const general = launch.mock.calls[0]?.[1];
    const resources = launch.mock.calls[1]?.[1];
    expect(general).toEqual(expect.arrayContaining(['--exclude', ...RESOURCE_TESTS]));
    expect(resources).toEqual(
      expect.arrayContaining(['--maxWorkers=1', '--fileParallelism=false', ...RESOURCE_TESTS]),
    );
  });

  it.each([
    [{ status: 1 }, { status: 0 }],
    [{ status: 0 }, { status: 1 }],
    [{ status: null, signal: 'SIGTERM' }, { status: 0 }],
    [{ status: null, error: new Error('spawn') }, { status: 0 }],
  ])('propaga cualquier fase roja y siempre ejecuta ambas (%j)', (one, two) => {
    const launch = vi.fn().mockReturnValueOnce(one).mockReturnValueOnce(two);
    expect(runSuite([], launch)).toBe(1);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('ejecuta recursos incluso si launch lanza excepción en general', () => {
    const launch = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('spawn');
      })
      .mockReturnValueOnce({ status: 0 });
    expect(runSuite([], launch)).toBe(1);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('los filtros externos nunca omiten ni paralelizan la fase de recursos', () => {
    const launch = vi.fn((_executable: string, _args: string[], _options: unknown) => ({
      status: 0,
    }));
    runSuite(['test/otro.test.ts', '--exclude', 'test/factory.test.ts', '--maxWorkers=8'], launch);
    const resources = launch.mock.calls[1]?.[1];
    expect(resources).not.toContain('test/otro.test.ts');
    expect(resources).not.toContain('--exclude');
    expect(resources).not.toContain('--maxWorkers=8');
    expect(resources).toEqual(expect.arrayContaining(RESOURCE_TESTS));
  });
});

import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { describeTarget, UNREADABLE_TARGET } from '../src/browser/target.js';

/** A page whose element read fails `failures` times and then answers. */
function fakePage(failures: number): { page: Page; timeouts: number[] } {
  const timeouts: number[] = [];
  let left = failures;
  const page = {
    locator: () => ({
      first: () => ({
        evaluate: async (_fn: unknown, _arg: unknown, opts: { timeout: number }) => {
          timeouts.push(opts.timeout);
          if (left-- > 0) throw new Error('Timeout');
          return 'button | Submit order @@ https://httpbin.org/forms/post';
        },
      }),
    }),
  } as unknown as Page;
  return { page, timeouts };
}

describe('describeTarget retry', () => {
  it('reads the element on the second, longer attempt instead of asking the user', async () => {
    const { page, timeouts } = fakePage(1);
    expect(await describeTarget(page, 'button')).toContain('Submit order');
    expect(timeouts).toEqual([2_000, 4_000]);
  });

  it('stays unreadable (fail closed) when both attempts fail', async () => {
    const { page, timeouts } = fakePage(2);
    expect(await describeTarget(page, 'button')).toBe(UNREADABLE_TARGET);
    expect(timeouts).toHaveLength(2);
  });

  it('does not retry when the first read works', async () => {
    const { page, timeouts } = fakePage(0);
    await describeTarget(page, 'button');
    expect(timeouts).toEqual([2_000]);
  });
});

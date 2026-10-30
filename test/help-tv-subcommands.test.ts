import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `pa --help` debe listar todas las órdenes de `pa tv`. README manda `pa tv mac auto`
 * y faltaban `pa tv orden`, `pa tv mac` y `pa tv wake` en la ayuda.
 */
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const tvCli = readFileSync(new URL('../src/tv/tv-cli.ts', import.meta.url), 'utf8');

function usageText(): string {
  const start = cli.indexOf('const USAGE = `');
  const end = cli.indexOf('`;', start);
  return cli.slice(start, end);
}

describe('pa --help y pa tv', () => {
  it('cada suborden de «uso: pa tv <…>» sale en la ayuda general', () => {
    const list = /uso: pa tv <([a-z|]+)>/.exec(tvCli)?.[1];
    expect(list).toBeTruthy();
    const usage = usageText();
    const missing = (list ?? '').split('|').filter((sub) => !usage.includes(`  pa tv ${sub}`));
    expect(missing).toEqual([]);
  });
});

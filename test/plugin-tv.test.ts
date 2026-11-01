import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import { tvPlugin, tvToolDeps } from '../src/plugins/tv.js';

describe('la tele como plugin (solo cableado)', () => {
  it('aporta una sola tool `tv` y no toca la tele al construirla', () => {
    const tools = tvPlugin.tools({ store: new Store() });
    expect(tvPlugin.id).toBe('tv');
    expect(tools.map((t) => t.name)).toEqual(['tv']);
    expect(typeof tvToolDeps).toBe('function');
  });

  it('cli.ts ya no lleva el cableado de la tele: lo pide al plugin', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).not.toMatch(/function tvToolDeps\(/);
    expect(cli).toMatch(/tvPlugin\.tools\(\{\s*store[\s,]/);
  });
});

import { describe, expect, it } from 'vitest';
import { tvCommand } from '../src/tv/tv-cli.js';

describe('tvCommand (uso)', () => {
  it('setup sin ip y sin teles a la vista devuelve 2 y lo explica', async () => {
    const errs: string[] = [];
    expect(
      await tvCommand(['setup'], { discover: async () => [], err: (s) => void errs.push(s) }),
    ).toBe(2);
    expect(errs.join('')).toContain('No veo ninguna tele LG encendida');
  });
  it('toast sin mensaje devuelve 2', async () => {
    expect(await tvCommand(['toast'])).toBe(2);
  });
  it('launch sin appId devuelve 2', async () => {
    expect(await tvCommand(['launch'])).toBe(2);
  });
  it('subcomando desconocido devuelve 2', async () => {
    expect(await tvCommand(['explode'])).toBe(2);
  });
  it('setup con host no-LAN devuelve 2 sin tocar la red', async () => {
    expect(await tvCommand(['setup', 'http://evil.example/x@y'])).toBe(2);
  });
});

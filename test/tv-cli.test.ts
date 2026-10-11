import { describe, expect, it } from 'vitest';
import { tvCommand } from '../src/tv/tv-cli.js';

describe('tvCommand (uso)', () => {
  it('setup sin ip devuelve 2', async () => {
    expect(await tvCommand(['setup'])).toBe(2);
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

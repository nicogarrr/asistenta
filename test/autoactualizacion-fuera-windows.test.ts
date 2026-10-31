import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOUPDATE_NOT_WINDOWS, autoupdateCommand } from '../src/autoupdate-cli.js';

const realPlatform = process.platform;
let err = '';
let state = '';
beforeEach(() => {
  err = '';
  state = mkdtempSync(join(tmpdir(), 'pa-autoact-fuera-'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err += String(s);
    return true;
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  vi.restoreAllMocks();
  rmSync(state, { recursive: true, force: true });
});

describe('pa autoupdate now fuera de Windows', () => {
  it.each(['linux', 'darwin'])('en %s dice cómo actualizar a mano', async (plat) => {
    Object.defineProperty(process, 'platform', { value: plat });
    expect(await autoupdateCommand(['now'], { stateDir: state, repo: state })).toBe(2);
    expect(err).toBe(`${AUTOUPDATE_NOT_WINDOWS}\n`);
    for (const paso of ['git pull', 'npm ci', 'npm run build', 'pa restart']) {
      expect(err).toContain(paso);
    }
  });
});

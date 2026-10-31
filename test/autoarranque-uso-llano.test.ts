import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autostartCommand } from '../src/autostart.js';
import { autoupdateCommand } from '../src/autoupdate-cli.js';

const realPlatform = process.platform;
let err = '';
let state = '';
beforeEach(() => {
  err = '';
  state = mkdtempSync(join(tmpdir(), 'pa-uso-llano-'));
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

const plain = (text: string) => {
  expect(text).toMatch(/^No conozco esa orden\. Usa: /);
  expect(text).not.toMatch(/uso:|\||\[--/);
  expect(text.trim().split('\n')).toHaveLength(1);
};

describe('una orden mal escrita se explica en llano', () => {
  it.each([[['instalar']], [['install', '--force']], [['status', 'x']]])(
    'pa autostart %j',
    async (args) => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(await autostartCommand(args, { stateDir: state })).toBe(2);
      plain(err);
      expect(err).toMatch(/install[^\n]*status[^\n]*uninstall/);
    },
  );

  it.each([[['ahora']], [['now', 'ya']]])('pa autoupdate %j', async (args) => {
    expect(await autoupdateCommand(args, { stateDir: state, repo: state })).toBe(2);
    plain(err);
    expect(err).toMatch(/status[^\n]*now[^\n]*off[^\n]*on/);
  });
});

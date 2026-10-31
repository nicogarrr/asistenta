import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it as baseIt, expect } from 'vitest';
import { openDaemonControl } from '../src/daemon-control.js';

const it = process.platform === 'linux' ? baseIt : baseIt.skip;
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

it('un ready.json roto tras un apagón ya no impide volver a arrancar', async () => {
  for (const content of ['', '{"version":1,"instan', '{"version":2}']) {
    const state = mkdtempSync(join(tmpdir(), 'pa-arranque-ready-linux-'));
    roots.push(state);
    chmodSync(state, 0o700);
    mkdirSync(join(state, 'control'), { mode: 0o700 });
    const ready = join(state, 'control', 'ready.json');
    writeFileSync(ready, content, { mode: 0o600 });
    const ctl = await openDaemonControl(state, () => {});
    expect(existsSync(ready)).toBe(false);
    await ctl.close();
  }
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'envfile-missing-'));
const prevCwd = process.cwd();
const prev = process.env.PA_STATE_DIR;

beforeAll(() => {
  delete process.env.PA_STATE_DIR;
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(prevCwd);
  if (prev === undefined) {
    delete process.env.PA_STATE_DIR;
  } else {
    process.env.PA_STATE_DIR = prev;
  }
  rmSync(dir, { recursive: true, force: true });
});

it('arranque sin .env: no lanza y no toca el entorno', async () => {
  await expect(import('../src/envfile.js')).resolves.toBeDefined();
  expect(process.env.PA_STATE_DIR).toBeUndefined();
});

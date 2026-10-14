import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'envfile-no-override-'));
const prevCwd = process.cwd();
const prev = process.env.PA_STATE_DIR;

beforeAll(() => {
  writeFileSync(join(dir, '.env'), 'PA_STATE_DIR=/tmp/envfile-no-debe-ganar\n');
  process.env.PA_STATE_DIR = '/tmp/envfile-prevalece';
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

it('una variable ya presente en el entorno nunca se pisa desde .env', async () => {
  await import('../src/envfile.js');
  expect(process.env.PA_STATE_DIR).toBe('/tmp/envfile-prevalece');
});

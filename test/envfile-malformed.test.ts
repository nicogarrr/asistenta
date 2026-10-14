import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'envfile-malformed-'));
const prevCwd = process.cwd();

beforeAll(() => {
  writeFileSync(join(dir, '.env'), '\tESTA LINEA NO ES UNA ASIGNACION =\n');
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

it('un .env malformado solo avisa por stderr, no tumba el arranque', async () => {
  await expect(import('../src/envfile.js')).resolves.toBeDefined();
});

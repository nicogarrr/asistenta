import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const shell = (command: string): ToolCall => ({
  tool: 'shell',
  args: { command },
  actor: 'asistenta',
});
// Control total: todo sin preguntar salvo dinero y credenciales.
const gate = () => new Gate({ fullControl: true, approver: async () => true });

let dir = '';
let prev = '';
beforeEach(() => {
  prev = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'gate-package-'));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(prev);
  rmSync(dir, { recursive: true, force: true });
});
const put = (name: string, content: string) => {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), content);
};
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts }, null, 2);

describe('npm ejecuta lo que dice package.json: también se lee', () => {
  it.each([
    ['npm run saca', { saca: 'pa vault get telegram:botToken' }],
    ['npm test', { test: 'pa cuentas exportar' }],
    ['npm ci', { postinstall: "node -e \"import('./dist/vault.js').then(v => v.vaultGet('x'))\"" }],
    ['pnpm run a', { a: 'pa vault get x' }],
  ])('%s', async (command, scripts) => {
    put('package.json', pkg(scripts));
    expect((await gate().check(S, shell(command))).verdict).toBe('deny');
  });

  it('tras cambiar de carpeta (cd)', async () => {
    put('sub/package.json', pkg({ a: 'pa vault get x' }));
    expect((await gate().check(S, shell('cd sub; npm run a'))).verdict).toBe('deny');
    expect(
      (await gate().check(S, shell(`Set-Location ${join(dir, 'sub')} && npm run a`))).verdict,
    ).toBe('deny');
  });

  it('un script lanzado tras cd se lee en esa carpeta', async () => {
    put('sub/a.ps1', 'pa vault get x');
    expect((await gate().check(S, shell('cd sub; .\\a.ps1'))).verdict).toBe('deny');
  });
});

describe('lo normal no cambia', () => {
  it.each([
    ['npm test', { test: 'vitest run' }],
    ['npm run build', { build: 'tsc -p tsconfig.build.json' }],
    ['npm ci', { postinstall: 'node scripts/setup.mjs' }],
    ['npm run lista', { lista: 'pa vault list' }],
  ])('%s', async (command, scripts) => {
    put('package.json', pkg(scripts));
    expect((await gate().check(S, shell(command))).verdict).toBe('allow');
  });

  it('sin package.json', async () => {
    expect((await gate().check(S, shell('npm test'))).verdict).toBe('allow');
  });

  it('npm view / npm ls no ejecutan scripts', async () => {
    put('package.json', pkg({ a: 'pa vault get x' }));
    expect((await gate().check(S, shell('npm ls'))).verdict).toBe('allow');
  });
});

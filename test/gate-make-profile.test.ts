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
const computer = (args: Record<string, unknown>): ToolCall => ({
  tool: 'computer',
  args,
  actor: 'asistenta',
});
const gate = () => new Gate({ fullControl: true, approver: async () => true });
const SECRET = 'pa vault get telegram:botToken';

let dir = '';
let prev = '';
let home: string | undefined;
beforeEach(() => {
  prev = process.cwd();
  home = process.env.HOME;
  dir = mkdtempSync(join(tmpdir(), 'gate-make-profile-'));
  process.chdir(dir);
  process.env.HOME = join(dir, 'home');
});
afterEach(() => {
  process.chdir(prev);
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  rmSync(dir, { recursive: true, force: true });
});
const put = (name: string, content: string) => {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), content);
};
const PROFILE = 'home/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1';

describe('make, just, VS Code y el perfil de PowerShell ejecutan lo que hay escrito', () => {
  it.each([
    ['Makefile', `build:\n\t${SECRET}\n`, 'make build'],
    ['sub/Makefile', `all:\n\t${SECRET}\n`, 'cd sub; make'],
    ['otro.mk', `x:\n\t${SECRET}\n`, 'make -f otro.mk x'],
    ['justfile', `test:\n    ${SECRET}\n`, 'just test'],
    [
      '.vscode/tasks.json',
      JSON.stringify({ tasks: [{ command: 'pa', args: ['vault', 'get', 'x'] }] }),
      'code .',
    ],
    [PROFILE, SECRET, 'powershell -Command "Get-Date"'],
    ['home/OneDrive/Documentos/PowerShell/profile.ps1', SECRET, 'pwsh -c ls'],
    [PROFILE, SECRET, 'Start-Process powershell'],
  ])('%s con «%s»', async (name, content, command) => {
    put(name, content);
    expect((await gate().check(S, shell(command))).verdict).toBe('deny');
  });

  it('abrir PowerShell tecleándolo en el escritorio carga el perfil', async () => {
    put(PROFILE, SECRET);
    const g = gate();
    expect((await g.check(S, computer({ action: 'type', text: 'powershell' }))).verdict).toBe(
      'deny',
    );
  });
});

describe('lo normal no cambia', () => {
  it.each([
    ['Makefile', 'build:\n\tnpm run build\n', 'make build'],
    ['justfile', 'test:\n    npx vitest run\n', 'just test'],
    [PROFILE, 'Set-Alias ll Get-ChildItem\npa status', 'powershell -Command "Get-Date"'],
    [PROFILE, SECRET, 'powershell -NoProfile -Command "Get-Date"'],
    [PROFILE, SECRET, 'pwsh -nop -c ls'],
    [PROFILE, SECRET, 'Get-Date'],
    ['x.txt', '', 'make build'],
    ['x.txt', '', 'code .'],
  ])('%s con «%s»', async (name, content, command) => {
    put(name, content);
    expect((await gate().check(S, shell(command))).verdict).toBe('allow');
  });
});

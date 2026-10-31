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
const gate = () => new Gate({ fullControl: true, approver: async () => true });

let dir = '';
let prev = '';
beforeEach(() => {
  prev = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'gate-code-spawns-'));
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
const SECRET = 'pa vault get telegram:botToken';

describe('un script de código que lanza otro script con secretos se deniega', () => {
  it.each([
    [
      'a.mjs',
      "import { spawnSync } from 'node:child_process';\nspawnSync('powershell', ['-File', 'b.ps1']);",
      'node a.mjs',
    ],
    [
      'a.js',
      "const { execSync } = require('child_process');\nexecSync('cmd /c b.bat');",
      'node a.js',
    ],
    ['a.py', "import subprocess\nsubprocess.run(['powershell', '-File', 'b.ps1'])", 'python a.py'],
    ['a.py', 'import os\nos.system("cmd /c b.bat")', 'python a.py'],
    [
      'sub/a.mjs',
      "import { execFileSync } from 'node:child_process';\nimport { join } from 'node:path';\nexecFileSync('powershell', ['-File', join(import.meta.dirname, 'c.ps1')]);",
      'node sub/a.mjs',
    ],
  ])('%s', async (name, content, command) => {
    put(name, content);
    put('b.ps1', SECRET);
    put('b.bat', `@echo off\r\n${SECRET}`);
    put('notas.txt', SECRET);
    put('sub/c.ps1', SECRET);
    expect((await gate().check(S, shell(command))).verdict).toBe('deny');
  });

  it('un .mjs que lanza otro .mjs que lanza un .ps1 (tres niveles)', async () => {
    put('a.mjs', "import { execSync } from 'node:child_process';\nexecSync('node b.mjs');");
    put(
      'b.mjs',
      "import { spawn } from 'node:child_process';\nspawn('powershell', ['-File', 'c.ps1']);",
    );
    put('c.ps1', SECRET);
    expect((await gate().check(S, shell('node a.mjs'))).verdict).toBe('deny');
  });
});

describe('el código normal no cambia', () => {
  it.each([
    // Lanza un script limpio.
    ["import { execSync } from 'node:child_process';\nexecSync('powershell -File ok.ps1');"],
    // Nombra un script con secretos pero no lanza procesos (solo lo lee o lo cita).
    ["import { readFileSync } from 'node:fs';\nconsole.log(readFileSync('b.ps1', 'utf8').length);"],
    // Texto suelto «node b.ps1» en un código sin procesos.
    ["console.log('usa: node b.ps1');"],
  ])('%s', async (content) => {
    put('a.mjs', content);
    put('ok.ps1', 'pa status\r\npa vault list');
    put('b.ps1', SECRET);
    expect((await gate().check(S, shell('node a.mjs'))).verdict).toBe('allow');
  });
});

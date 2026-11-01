import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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
// Control total: todo sin preguntar salvo dinero y credenciales.
const gate = (protectedPaths?: string[]) =>
  new Gate({ fullControl: true, approver: async () => true, protectedPaths });

let dir = '';
let prev = '';
beforeEach(() => {
  prev = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'gate-runs-script-'));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(prev);
  rmSync(dir, { recursive: true, force: true });
});
const put = (name: string, content: string | Buffer) => {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), content);
};

describe('lanzar un script que saca secretos se deniega aunque se escribiera por otra vía', () => {
  it.each([
    ['a.ps1', 'pa vault get telegram:botToken', './a.ps1'],
    ['a.ps1', 'pa vault get telegram:botToken', '.\\a.ps1'],
    ['a.ps1', 'pa vault get x', 'powershell -ExecutionPolicy Bypass -File a.ps1'],
    ['b.bat', '@echo off\r\npa cuentas exportar', 'cmd /c b.bat'],
    [
      'c.mjs',
      "import { vaultGet } from './dist/vault.js';\nconsole.log(await vaultGet('x'));",
      'node c.mjs',
    ],
    ['d.py', "import subprocess\nsubprocess.run(['pa', 'vault', 'get', 'x'])", 'python d.py'],
    ['notas.txt', 'pa vault get provider:apiKey', 'Get-Content notas.txt | iex'],
    ['notas.txt', '$v = "vault"; pa $v get x', 'gc notas.txt -Raw | Invoke-Expression'],
    ['e.ps1', '& ./f.ps1', '& ./e.ps1'],
    [
      'i.ps1',
      `powershell -EncodedCommand ${Buffer.from('pa vault get x', 'utf16le').toString('base64')}`,
      '.\\i.ps1',
    ],
    ['j.ps1', '$p = ("pa vault g", "et x") -join ""; iex $p', '.\\j.ps1'],
  ])('deniega %s lanzado con «%s»', async (name, content, command) => {
    put(name, content);
    if (name === 'e.ps1') put('f.ps1', 'pa vault get x');
    const d = await gate().check(S, shell(command));
    expect(d.verdict).toBe('deny');
  });

  it('lee el UTF-16 que deja «>» en PowerShell 5.1', async () => {
    put(
      'g.ps1',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('pa vault get x\r\n', 'utf16le')]),
    );
    expect((await gate().check(S, shell('.\\g.ps1'))).verdict).toBe('deny');
  });

  it('un .ps1 enorme que no se puede revisar se deniega', async () => {
    put('h.ps1', `${'#'.repeat(1024 * 1024 + 10)}\npa status`);
    expect((await gate().check(S, shell('.\\h.ps1'))).verdict).toBe('deny');
  });

  it('también en una terminal del escritorio (tecleado con computer)', async () => {
    put('a.ps1', 'pa vault get x');
    const d = await gate().check(S, computer({ action: 'type', text: '.\\a.ps1' }));
    expect(d.verdict).toBe('deny');
  });
});

describe('las órdenes normales no cambian', () => {
  it.each([
    ['ok.ps1', 'pa status\r\npa vault list', 'powershell -ExecutionPolicy Bypass -File ok.ps1'],
    ['ok.ps1', 'npx vitest run --maxWorkers=2', '.\\ok.ps1'],
    ['run.mjs', "console.log('hola')", 'node run.mjs'],
    ['README.md', 'Para ver una clave: pa vault get <k>', 'cat README.md'],
    ['README.md', 'Para ver una clave: pa vault get <k>', 'type README.md'],
    ['test/x.test.ts', "it('pa vault get', () => {})", 'npx vitest run test/x.test.ts'],
    ['x.txt', '', 'npm test'],
    ['x.txt', '', 'pa status'],
    ['x.txt', '', 'node no-existe.mjs'],
  ])('%s + «%s»', async (name, content, command) => {
    put(name, content);
    expect((await gate().check(S, shell(command))).verdict).toBe('allow');
  });

  it('el código de la propia app (protegido) no se lee: node dist/cli.js status', async () => {
    put('dist/cli.js', "import './vault.js'; // pa vault get <k>");
    expect(
      (await gate([join(dir, 'dist')]).check(S, shell('node dist/cli.js status'))).verdict,
    ).toBe('allow');
  });
});

describe('los scripts del propio repo se pueden lanzar', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = (d: string): string[] =>
    readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
    );
  // instalar.mjs (token del bot) y tvstate.mjs (claves de la tele) leen el vault: los lanza Nico.
  const readsVault = /(instalar|tvstate)\.mjs$/;
  const scripts = [...files('scripts'), ...files('deploy')].filter(
    (f) => /\.(ps1|bat|cmd|sh|[cm]?js|ts|py)$/i.test(f) && !readsVault.test(f),
  );
  it.each(['scripts/instalar.mjs', 'deploy/tv-webos/tvstate.mjs'])(
    '%s lee el vault, así que el modelo no lo lanza',
    async (f) => {
      process.chdir(root);
      expect((await gate().check(S, shell(`node ${f}`))).verdict).toBe('deny');
    },
  );
  it('hay scripts que revisar', () => expect(scripts.length).toBeGreaterThan(5));
  it('ninguno se deniega', async () => {
    process.chdir(root);
    const denied: string[] = [];
    for (const f of scripts) {
      const runner = /\.ps1$/i.test(f)
        ? 'powershell -ExecutionPolicy Bypass -File'
        : /\.(bat|cmd)$/i.test(f)
          ? 'cmd /c'
          : /\.py$/i.test(f)
            ? 'python'
            : /\.sh$/i.test(f)
              ? 'bash'
              : 'node';
      const d = await gate().check(S, shell(`${runner} ${relative(root, join(root, f))}`));
      if (d.verdict !== 'allow') denied.push(f);
    }
    expect(denied).toEqual([]);
  });
});

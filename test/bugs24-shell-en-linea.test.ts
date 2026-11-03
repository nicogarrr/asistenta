/**
 * El código en línea de la ventana de shell (#1895/#1942) nunca casaba en su forma normal:
 * `\s+` se comía el único espacio tras `powershell`/`python`/`node`/`cmd` y `(^|\s)` ya no
 * tenía cuál. Con un comando ya aprobado, durante 90 s pasaban sin preguntar
 * `python -c "…"`, `node -e "…"`, `cmd /c …` o `powershell -c/-Command/-File …`, también
 * tras leer una web con «Siempre». Solo preguntaba con otra bandera delante
 * (`python -B -c …`). (`powershell -enc` ya se deniega aparte.) Lo mismo con el git que tira
 * trabajo: la regla solo veía la bandera justo detrás (`git clean -f`, `git reset --hard`), y
 * `git clean -d -f`, `git reset HEAD~1 --hard`, `git checkout .`, `git restore .`,
 * `git branch -D` o `git stash drop` pasaban sin preguntar. Solo endurece.
 */
import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const call = (tool: string, args: Record<string, unknown> = {}): ToolCall => ({
  tool,
  args,
  actor: 'owner',
});

function gateWith() {
  const asked: string[] = [];
  const gate = new Gate({
    approver: async (c, reason) => {
      asked.push(`${c.tool}: ${reason}`);
      return true;
    },
  });
  return { gate, asked };
}

const EN_LINEA = [
  'python -c "import os; os.system(\'x\')"',
  'python3 -c "print(1)"',
  'py -c "print(1)"',
  'node -e "process.exit(0)"',
  'node -p "1+1"',
  'cmd /c dir C:\\',
  'cmd.exe /k echo hola',
  'powershell -c "Get-Process"',
  'pwsh -Command Get-Date',
  'powershell -File x.txt',
  'mshta vbscript:Execute("x")',
];

describe('ventana de shell: código en línea y git que tira trabajo preguntan', () => {
  it.each(EN_LINEA)('con la ventana abierta, «%s» pregunta', async (command) => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    const d = await gate.check(S, call('shell', { command }));
    expect(d.reason).toBe('approved by owner');
    expect(asked).toHaveLength(2);
  });

  it.each([
    'git clean -d -f',
    'git clean --force',
    'git reset HEAD~1 --hard',
    'git checkout .',
    'git checkout HEAD -- src/a.ts',
    'git restore .',
    'git restore src/a.ts',
    'git switch --discard-changes main',
    'git branch -D rama-sin-fusionar',
    'git stash drop',
    'git stash clear',
    'git push --mirror',
    'git reflog expire --expire=now --all',
  ])('git que tira trabajo, «%s», pregunta con la ventana abierta', async (command) => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    const d = await gate.check(S, call('shell', { command }));
    expect(d.reason).toBe('approved by owner');
    expect(asked).toHaveLength(2);
  });

  it('leer o diagnosticar sigue dentro de la ventana', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    for (const command of [
      'python --version',
      'node --version',
      'node -v',
      'python script.py',
      'pwsh --version',
      'Get-Process node',
      'git commit -m "arregla -c"',
      'git status',
      'git diff',
      'git restore --staged .',
      'git switch main',
      'git stash pop',
      'git clean -n',
      'git push origin main',
    ]) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked).toHaveLength(1);
  });
});

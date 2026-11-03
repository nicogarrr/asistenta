/**
 * Instalar sin las palabras que SHELL_INSTALL buscaba al principio del comando: `uvx`,
 * `uv tool install`, `pipx run`, `pip3.11 install`, `yarn global add`, `npm exec`,
 * `go/gem/conda install`, `dotnet tool install`, `(npm install …)` o activar componentes de
 * Windows. Con un comando ya aprobado, la ventana de 90 s los dejaba pasar sin preguntar,
 * también tras leer una web. Regla de Nico (#1895): instalar cosas pregunta siempre.
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

const RIESGOS = [
  'uvx ruff check .',
  'uv tool install httpie',
  'uv pip install requests',
  'uv add requests',
  'pipx install httpie',
  'pipx run cowsay hola',
  'pip3.11 install requests',
  'py -m pip install requests',
  'yarn global add serve',
  'npm exec -- create-vite',
  'cargo install ripgrep',
  'go install example.com/tool@latest',
  'gem install rails',
  'dotnet tool install -g x',
  'conda install numpy',
  '(npm install left-pad)',
  'Add-WindowsCapability -Online -Name OpenSSH.Server',
  'Enable-WindowsOptionalFeature -Online -FeatureName x',
  'dism /online /enable-feature /featurename:x',
];
describe('ventana de shell: instalar pregunta en cualquier forma', () => {
  it.each(RIESGOS)('con la ventana abierta, «%s» pregunta', async (command) => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    await gate.check(S, call('shell', { command }));
    expect(asked).toHaveLength(2);
  });

  it('consultar versiones y paquetes sigue dentro de la ventana', async () => {
    const { gate, asked } = gateWith();
    await gate.check(S, call('shell', { command: 'Get-Date' }));
    for (const command of [
      'npm --version',
      'npm ls',
      'npm run build',
      'npm init -y',
      'pip list',
      'pip show requests',
      'uv --version',
      'go version',
      'winget list',
    ]) {
      await gate.check(S, call('shell', { command }));
    }
    expect(asked).toHaveLength(1);
  });
});

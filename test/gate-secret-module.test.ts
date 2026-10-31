import { describe, expect, it } from 'vitest';
import { Gate, type ToolCall } from '../src/permissions.js';

const S = 'chat-1';
const shell = (command: string): ToolCall => ({
  tool: 'shell',
  args: { command },
  actor: 'asistenta',
});

// Control total: todo sin preguntar salvo dinero y credenciales.
function gate() {
  const g = new Gate({ fullControl: true, approver: async () => true });
  return g;
}

describe('el shell del modelo no carga el módulo del vault a mano', () => {
  it.each([
    `node -e "import('./dist/vault.js').then(v => v.vaultGet('provider:apiKey')).then(console.log)"`,
    `node --input-type=module -e "import { vaultGet } from 'C:\\asistenta\\dist\\vault.js'; console.log(await vaultGet('telegram:token'))"`,
    `node -e "import('./dist/vault').then(v => v.vaultGet('x'))"`,
    `node -e "require('./dist/credentials/store.js').list()"`,
    `npx tsx -e "import('./src/vault.ts')"`,
  ])('deniega: %s', async (command) => {
    const d = await gate().check(S, shell(command));
    expect(d.verdict).toBe('deny');
    expect(d.reason).toMatch(/terminal/);
  });

  it.each([
    'npx vitest run test/vault-stdin-process.test.ts',
    'pa vault list',
    'node dist/cli.js status',
    'type C:\\asistenta\\README.md',
    'git log --oneline -3 -- src/vault.ts',
  ])('no cambia: %s', async (command) => {
    const d = await gate().check(S, shell(command));
    expect(d.verdict).toBe('allow');
  });
});

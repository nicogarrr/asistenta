import { afterEach, describe, expect, it, vi } from 'vitest';
import { protectedPaths, secretStatePaths } from '../src/daemon/gate.js';
import { Gate, type ToolCall } from '../src/permissions.js';

afterEach(() => vi.unstubAllEnvs());

const FILE = 'C:\\Claves\\secrets.json';
const call = (tool: string, path: string): ToolCall => ({
  tool,
  args: { path, content: '{}' },
  actor: 'asistenta',
});

describe('el fichero de secretos del vault portátil, fuera del estado', () => {
  it('no se puede leer ni escribir con las herramientas del modelo', async () => {
    vi.stubEnv('PA_SECRETS_FILE', FILE);
    const g = new Gate({
      fullControl: true,
      approver: async () => true,
      secretPaths: secretStatePaths(),
      protectedPaths: protectedPaths(),
    });
    expect((await g.check('s', call('read', FILE))).verdict).toBe('deny');
    expect((await g.check('s', call('write', FILE))).verdict).toBe('deny');
    expect((await g.check('s', call('read', 'C:\\Claves\\notas.txt'))).verdict).toBe('allow');
  });
});

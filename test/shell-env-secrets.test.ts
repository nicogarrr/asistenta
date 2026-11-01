import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createShellTool, shellEnv } from '../src/tools/shell.js';

const config = { idleTimeoutMs: 600_000, toolTimeoutMs: 30_000 } as Config;

/** spawn falso que guarda el entorno que recibe el hijo y termina enseguida. */
function capturingSpawn() {
  const seen: NodeJS.ProcessEnv[] = [];
  const spawn = vi.fn((_file: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    seen.push(opts.env);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 4242,
      kill: vi.fn(),
    });
    setImmediate(() => child.emit('close', 0));
    return child;
  });
  return { spawn, seen };
}

afterEach(() => vi.unstubAllEnvs());

describe('shell del modelo sin secretos en el entorno', () => {
  it('printenv no puede enseñar los secretos del vault portátil ni tokens del daemon', async () => {
    vi.stubEnv('PA_VAULT_BACKEND', 'portable');
    vi.stubEnv('PA_SECRET_TELEGRAM_BOTTOKEN', 'sk-secreto-1');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-secreto-2');
    vi.stubEnv('PA_WEB_TOKEN', 'sk-secreto-3');
    vi.stubEnv('PA_SECRETS_FILE', '/tmp/secrets.json');
    const { spawn, seen } = capturingSpawn();
    const tool = createShellTool(config, { spawn: spawn as never, env: {} });
    await tool.execute('t1', { command: 'Get-ChildItem env:' });
    const env = seen[0] ?? {};
    const dump = JSON.stringify(env);
    expect(dump).not.toContain('sk-secreto');
    expect(env.PA_SECRET_TELEGRAM_BOTTOKEN).toBeUndefined();
    expect(env.PA_SECRETS_FILE).toBe('/tmp/secrets.json');
    expect(env.PA_VAULT_BACKEND).toBe('portable');
    expect(env.NO_COLOR).toBe('1');
  });

  it('las variables normales (PATH, TEMP) pasan intactas', () => {
    const env = shellEnv({ PATH: '/bin', TEMP: '/tmp', PA_SECRET_X: 'y', GITHUB_TOKEN: 'z' });
    expect(env).toEqual({ PATH: '/bin', TEMP: '/tmp', NO_COLOR: '1' });
  });
});

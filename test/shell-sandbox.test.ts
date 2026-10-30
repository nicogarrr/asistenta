import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createShellTool } from '../src/tools/shell.js';
import { buildSandboxSpawn, sandboxMode } from '../src/tools/shell-sandbox.js';

const config = { idleTimeoutMs: 600_000, toolTimeoutMs: 30_000 } as Config;

/** spawn falso: registra la llamada y responde como un proceso que termina bien o falla. */
function fakeSpawn(opts: { error?: string; out?: string } = {}) {
  return vi.fn((_file: string, _args: string[], _o?: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    setImmediate(() => {
      if (opts.error) {
        const e = new Error(opts.error);
        child.emit('error', e);
        return;
      }
      child.stdout.emit('data', Buffer.from(opts.out ?? 'ok'));
      child.emit('close', 0);
    });
    return child;
  });
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('');

describe('sandboxMode', () => {
  it('off por defecto; docker reconocido; cualquier otro valor se rechaza', () => {
    expect(sandboxMode({})).toEqual({ ok: true, mode: 'off' });
    expect(sandboxMode({ PA_SHELL_SANDBOX: 'docker' })).toEqual({ ok: true, mode: 'docker' });
    expect(sandboxMode({ PA_SHELL_SANDBOX: 'wsl' }).ok).toBe(false);
    expect(sandboxMode({ PA_SHELL_SANDBOX: 'dokcer' }).ok).toBe(false);
  });
});

describe('buildSandboxSpawn', () => {
  it('off: pwsh en el PC exactamente como antes', () => {
    expect(
      buildSandboxSpawn({ mode: 'off', shellFile: 'pwsh.exe', command: 'dir', workspace: 'C:\\w' }),
    ).toEqual({ file: 'pwsh.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'dir'] });
  });

  it('docker: sin red, raíz de solo lectura, sin capacidades, solo la carpeta de trabajo', () => {
    const s = buildSandboxSpawn({
      mode: 'docker',
      shellFile: 'pwsh.exe',
      command: 'Get-ChildItem',
      workspace: 'C:\\Users\\nico\\trabajo',
      name: 'pa-shell-x',
    });
    expect(s.file).toBe('docker');
    expect(s.container).toBe('pa-shell-x');
    const a = s.args.join(' ');
    expect(a).toContain('--network none');
    expect(a).toContain('--read-only');
    expect(a).toContain('--cap-drop ALL');
    expect(a).toContain('--user 1000:1000');
    expect(a).toContain('-v C:/Users/nico/trabajo:/work');
    expect(s.args.slice(-5)).toEqual([
      'pwsh',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-ChildItem',
    ]);
    // El comando es UN argumento: nada de shell del host por medio.
    expect(s.args.filter((x) => x === 'Get-ChildItem')).toHaveLength(1);
  });
});

describe('herramienta shell con sandbox', () => {
  it('modo inválido: rechaza sin lanzar nada', async () => {
    const spawn = fakeSpawn();
    const tool = createShellTool(config, {
      spawn: spawn as never,
      env: { PA_SHELL_SANDBOX: 'wsl' },
    });
    const r = await tool.execute('t1', { command: 'whoami' } as never);
    expect(spawn).not.toHaveBeenCalled();
    expect(text(r as never)).toContain('no es un modo válido');
  });

  it('docker ausente: error claro y NO cae a pwsh en el PC', async () => {
    const spawn = fakeSpawn({ error: 'spawn docker ENOENT' });
    const tool = createShellTool(config, {
      spawn: spawn as never,
      env: { PA_SHELL_SANDBOX: 'docker' },
    });
    const r = await tool.execute('t2', { command: 'whoami' } as never);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe('docker');
    expect(text(r as never)).toContain('no encuentro docker');
  });

  it('off: lanza pwsh con -Command, como siempre', async () => {
    const spawn = fakeSpawn({ out: 'hola' });
    const tool = createShellTool(config, { spawn: spawn as never, env: {} });
    const r = await tool.execute('t3', { command: 'echo hola' } as never);
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'echo hola',
    ]);
    expect(text(r as never)).toContain('hola');
  });
});

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createShellTool, decodeWindowsOutput, withUtf8Output } from '../src/tools/shell.js';

const config = { idleTimeoutMs: 600_000, toolTimeoutMs: 30_000 } as Config;

function fakeSpawn(out: Buffer) {
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
      child.stdout.emit('data', out);
      child.emit('close', 0);
    });
    return child;
  });
}

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? '').join('');

// «Configuración Ñandú» como lo escribe la consola de un Windows en español (página 850).
const CP850 = Buffer.from([
  ...Buffer.from('Configuraci'),
  0xa2,
  ...Buffer.from('n '),
  0xa5,
  ...Buffer.from('and'),
  0xa3,
]);

describe('shell en Windows: tildes y eñes de la salida de PowerShell', () => {
  it('la salida en página 850 llega bien, no como «Configuraci�n»', async () => {
    const spawn = fakeSpawn(CP850);
    const tool = createShellTool(config, { spawn: spawn as never, env: {}, platform: 'win32' });
    const r = await tool.execute('t1', { command: 'Get-ChildItem' } as never);
    expect(text(r as never)).toContain('Configuración Ñandú');
    expect(text(r as never)).not.toContain('\uFFFD');
  });

  it('se pide UTF-8 a la consola antes del comando (solo en Windows)', async () => {
    const spawn = fakeSpawn(Buffer.from('ok'));
    const tool = createShellTool(config, { spawn: spawn as never, env: {}, platform: 'win32' });
    await tool.execute('t2', { command: 'Get-ChildItem' } as never);
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(args[3]).toMatch(
      /OutputEncoding = \[System\.Text\.UTF8Encoding\]::new\(\$false\).*; Get-ChildItem$/,
    );

    const linux = fakeSpawn(Buffer.from('ok'));
    const tool2 = createShellTool(config, { spawn: linux as never, env: {}, platform: 'linux' });
    await tool2.execute('t3', { command: 'echo hola' } as never);
    expect((linux.mock.calls[0]?.[1] as string[])[3]).toBe('echo hola');
  });

  it('mezcla de UTF-8 y 850 línea a línea; using/param se dejan primero', () => {
    const mixed = Buffer.concat([Buffer.from('Canción\n', 'utf8'), CP850]);
    expect(decodeWindowsOutput(mixed)).toBe('Canción\nConfiguración Ñandú');
    expect(decodeWindowsOutput(Buffer.from('línea\r\notra', 'utf8'))).toBe('línea\r\notra');
    expect(withUtf8Output('using namespace System.IO; [Path]::GetTempPath()')).toBe(
      'using namespace System.IO; [Path]::GetTempPath()',
    );
    expect(withUtf8Output('Get-Date')).toMatch(/; Get-Date$/);
  });

  it('en Linux la salida UTF-8 sigue igual', async () => {
    const spawn = fakeSpawn(Buffer.from('ñandú', 'utf8'));
    const tool = createShellTool(config, { spawn: spawn as never, env: {}, platform: 'linux' });
    expect(text((await tool.execute('t4', { command: 'x' } as never)) as never)).toContain('ñandú');
  });
});

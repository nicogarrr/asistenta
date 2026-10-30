import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createShellTool, OutputCollector } from '../src/tools/shell.js';

const config = { idleTimeoutMs: 600_000, toolTimeoutMs: 30_000 } as Config;

type Child = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

/** spawn falso: el comando termina a los `closeAfter` ms salvo que lo maten antes. */
function fakeSpawn(closeAfter: number) {
  const children: Child[] = [];
  const spawn = vi.fn((file: string) => {
    const child = new EventEmitter() as Child;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    if (file === 'taskkill.exe') {
      // Como en Linux/Mac: el binario no existe y spawn emite 'error' después.
      setImmediate(() => child.emit('error', new Error('spawn taskkill.exe ENOENT')));
      return child;
    }
    let closed = false;
    const close = (code: number | null) => {
      if (closed) return;
      closed = true;
      child.emit('close', code);
    };
    child.kill = vi.fn(() => setImmediate(() => close(null)));
    setTimeout(() => {
      child.stdout.emit('data', Buffer.from('listo'));
      close(0);
    }, closeAfter);
    children.push(child);
    return child;
  });
  return { spawn, children };
}

const text = (r: { content: { text: string }[] }) => r.content[0]?.text ?? '';

describe('OutputCollector y UTF-8', () => {
  it('sin hueco, una «ñ» partida entre cabeza y cola sale entera', () => {
    const c = new OutputCollector(8);
    const all = Buffer.from('abcdefgñxyz'); // la ñ ocupa los bytes 7 y 8
    c.push(all.subarray(0, 8));
    c.push(all.subarray(8));
    expect(c.omitted).toBe(0);
    expect(c.text()).toBe('abcdefgñxyz');
  });

  it('con hueco y sin saltos de línea, no aparecen caracteres basura en los cortes', () => {
    const c = new OutputCollector(9);
    c.push(Buffer.from('áéíóúáéíóúáéíóúáéíóú'));
    const out = c.text();
    expect(out).not.toContain('\uFFFD');
    expect(out).toContain('omitted from the middle');
  });
});

describe('shell: límites de tiempo y cancelación', () => {
  for (const bad of [0, -5, Number.NaN]) {
    it(`timeoutMs ${bad} usa el de por defecto en vez de matar el comando al instante`, async () => {
      const { spawn } = fakeSpawn(30);
      const tool = createShellTool(config, { spawn: spawn as never, env: {} });
      const r = await tool.execute('t', { command: 'echo', timeoutMs: bad } as never);
      expect(r.details).toMatchObject({ exitCode: 0, timedOut: false });
      expect(text(r as never)).toContain('listo');
    });
  }

  it('un timeout de verdad mata el proceso sin tumbar nada aunque taskkill no exista', async () => {
    const { spawn, children } = fakeSpawn(60_000);
    const tool = createShellTool(config, { spawn: spawn as never, env: {} });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const run = tool.execute('t', { command: 'sleep', timeoutMs: 1_000 } as never);
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      const r = await run;
      await new Promise((ok) => setTimeout(ok, 10));
      expect(r.details).toMatchObject({ timedOut: true, aborted: false });
      expect(text(r as never)).toContain('[timed out after 1000ms]');
      if (process.platform !== 'win32') expect(children[0]?.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('un /stop (abort) se informa como cancelado, no como timeout', async () => {
    const { spawn } = fakeSpawn(60_000);
    const tool = createShellTool(config, { spawn: spawn as never, env: {} });
    const ac = new AbortController();
    const run = tool.execute('t', { command: 'sleep' } as never, ac.signal);
    setTimeout(() => ac.abort(), 5);
    const r = await run;
    expect(r.details).toMatchObject({ timedOut: false, aborted: true });
    expect(text(r as never)).toContain('cancelled before finishing');
    expect(text(r as never)).not.toContain('timed out');
  });
});

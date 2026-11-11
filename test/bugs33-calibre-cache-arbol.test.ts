import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  _resetConverterCacheForTests,
  CONVERTER_MISS_TTL_MS,
  findConverter,
  makeRunner,
  type Runner,
} from '../src/books/convert.js';

// bugs-33 (11 nov 2026), dos fallos de Calibre en el PC de Nico:
// 1) Cada «📖 Al Kindle» (y cada libro) volvía a buscar el conversor lanzando
//    `ebook-convert --version` en cada candidato: en Windows eso es arrancar Python de
//    Calibre, ~1–3 s por candidato y por llamada, para algo que no cambia.
// 2) Al pasar los 5 min, execFile mataba SOLO ebook-convert.exe: en Windows no hay
//    señales y sus procesos hijos (calibre-parallel, los que de verdad convierten)
//    quedaban vivos comiendo CPU. Ahora se mata el árbol entero (taskkill /T).

describe('Calibre: el conversor se busca una vez', () => {
  it('dos conversiones seguidas no vuelven a lanzar --version', async () => {
    _resetConverterCacheForTests();
    let probes = 0;
    const run: Runner = async (cmd, args) => {
      if (args[0] === '--version') probes++;
      return { code: cmd === 'ebook-convert' ? 0 : 1, stderr: '' };
    };
    expect(await findConverter(run, {})).toBe('ebook-convert');
    expect(await findConverter(run, {})).toBe('ebook-convert');
    expect(probes).toBe(1);
  });

  it('si no hay Calibre, se vuelve a mirar pasado un rato (por si lo instala con winget)', async () => {
    _resetConverterCacheForTests();
    let installed = false;
    let probes = 0;
    const run: Runner = async () => {
      probes++;
      return { code: installed ? 0 : 1, stderr: '' };
    };
    let now = 1_000_000;
    expect(await findConverter(run, {}, () => now)).toBeNull();
    const first = probes;
    expect(await findConverter(run, {}, () => now + 1000)).toBeNull();
    expect(probes).toBe(first); // no se repite enseguida
    installed = true;
    now += CONVERTER_MISS_TTL_MS + 1;
    expect(await findConverter(run, {}, () => now)).toBe('ebook-convert');
  });
});

class FakeChild extends EventEmitter {
  pid = 4242;
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(sig: string) {
    this.killed.push(sig);
    return true;
  }
}

describe('Calibre: al pasarse de tiempo se mata el árbol entero', () => {
  it('en Windows: taskkill /F /T /PID (no solo el ebook-convert.exe)', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      const spawnImpl = ((cmd: string, args: string[]) => {
        spawned.push({ cmd, args });
        if (/taskkill/i.test(cmd)) {
          setTimeout(() => child.emit('close', 1), 10);
          return new FakeChild();
        }
        return child;
      }) as never;
      const run = makeRunner({ spawnImpl, platform: 'win32' });
      const p = run('C:\\Program Files\\Calibre2\\ebook-convert.exe', ['a', 'b'], 1000);
      await vi.advanceTimersByTimeAsync(1100);
      const r = await p;
      const tk = spawned.find((s) => /taskkill/i.test(s.cmd));
      expect(tk?.args).toEqual(['/F', '/T', '/PID', '4242']);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/ETIMEDOUT/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fuera de Windows: se mata el grupo de procesos (kill(-pid))', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const kills: Array<[number, string]> = [];
      const run = makeRunner({
        spawnImpl: (() => child) as never,
        platform: 'linux',
        kill: ((pid: number, sig: string) => {
          kills.push([pid, sig]);
          setTimeout(() => child.emit('close', null), 5);
          return true;
        }) as never,
      });
      const p = run('ebook-convert', ['a', 'b'], 1000);
      await vi.advanceTimersByTimeAsync(1100);
      const r = await p;
      expect(kills).toEqual([[-4242, 'SIGKILL']]);
      expect(r.stderr).toMatch(/ETIMEDOUT/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('una conversión que acaba bien devuelve su código y su stderr', async () => {
    const child = new FakeChild();
    const run = makeRunner({ spawnImpl: (() => child) as never, platform: 'win32' });
    const p = run('ebook-convert', ['x'], 60_000);
    child.stderr.emit('data', Buffer.from('aviso'));
    child.emit('close', 0);
    expect(await p).toEqual({ code: 0, stderr: 'aviso' });
  });

  it('un ebook-convert que no existe es un fallo, no una excepción', async () => {
    const child = new FakeChild();
    const run = makeRunner({ spawnImpl: (() => child) as never, platform: 'linux' });
    const p = run('ebook-convert', ['--version'], 10_000);
    child.emit('error', Object.assign(new Error('spawn ebook-convert ENOENT'), { code: 'ENOENT' }));
    const r = await p;
    expect(r.code).not.toBe(0);
  });
});

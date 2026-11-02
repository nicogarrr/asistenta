import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PsHost,
  PsHostLost,
  PsHostUnavailable,
  PsScriptError,
  psLatencySummary,
  resetPsLatency,
} from '../src/screen/ps-host.js';
import { defaultRunner, powerShellWasCut } from '../src/screen/windows.js';

type Behaviour = (script: string, id: string, reply: (s: string) => void, kill: () => void) => void;

/** Hijo simulado que habla el mismo protocolo de líneas que el bootstrap de PowerShell. */
function fakeChild(behaviour: Behaviour) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: () => undefined,
  });
  const received: string[] = [];
  let buf = '';
  const kill = () => proc.emit('exit', 1);
  stdin.on('data', (d: Buffer) => {
    buf += d.toString();
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const sp = line.indexOf(' ');
      const id = line.slice(0, sp);
      const script = Buffer.from(line.slice(sp + 1), 'base64').toString('utf8');
      received.push(script);
      behaviour(script, id, (s) => stdout.write(s), kill);
    }
  });
  return { proc: proc as never, received };
}

const ok: Behaviour = (script, id, reply) => {
  if (script.includes('PA_HOST_READY')) reply(`PA_HOST_READY\n\nPA_DONE ${id} 0\n`);
  else if (script.includes('boom')) {
    const msg = Buffer.from('Excepción: boom').toString('base64');
    reply(`\nPA_ERR ${id} ${msg}\n\nPA_DONE ${id} 1\n`);
  } else reply(`eco:${script}\n\nPA_DONE ${id} 0\n`);
};

describe('PsHost + defaultRunner', () => {
  beforeEach(() => resetPsLatency());

  it('ejecuta scripts en serie por un único proceso', async () => {
    let spawned = 0;
    const host = new PsHost(
      {},
      {
        spawnHost: () => {
          spawned += 1;
          return fakeChild(ok).proc;
        },
      },
    );
    const [a, b] = await Promise.all([host.run('uno'), host.run('dos')]);
    expect(a.stdout).toContain('eco:uno');
    expect(b.stdout).toContain('eco:dos');
    expect(spawned).toBe(1);
    host.close();
  });

  it('un error del script llega como PsScriptError sin matar el host', async () => {
    const host = new PsHost({}, { spawnHost: () => fakeChild(ok).proc });
    await expect(host.run('boom')).rejects.toBeInstanceOf(PsScriptError);
    expect((await host.run('sigue')).stdout).toContain('eco:sigue');
    host.close();
  });

  it('si no arranca, usa el camino de siempre', async () => {
    const host = new PsHost(
      {},
      {
        spawnHost: () => {
          throw new Error('ENOENT');
        },
      },
    );
    await expect(host.run('x')).rejects.toBeInstanceOf(PsHostUnavailable);
    const run = defaultRunner({}, host, async (s) => ({ stdout: `spawn:${s}`, stderr: '' }));
    expect((await run('x')).stdout).toBe('spawn:x');
    expect(psLatencySummary().spawn?.n).toBe(1);
  });

  it('si el host muere con el script enviado, falla y NO repite', async () => {
    const calls: string[] = [];
    const host = new PsHost(
      {},
      {
        spawnHost: () =>
          fakeChild((s, id, reply, kill) => {
            if (s.includes('muere')) kill();
            else ok(s, id, reply, kill);
          }).proc,
      },
    );
    const run = defaultRunner({}, host, async (s) => {
      calls.push(s);
      return { stdout: '', stderr: '' };
    });
    await expect(run('muere')).rejects.toThrow(/PowerShell falló/);
    expect(calls).toEqual([]);
  });

  it('un corte por tiempo se reconoce como corte y no repite', async () => {
    const host = new PsHost(
      {},
      {
        timeoutMs: 40,
        spawnHost: () =>
          fakeChild((s, id, reply, kill) => {
            if (s.includes('cuelga')) return;
            ok(s, id, reply, kill);
          }).proc,
      },
    );
    await expect(host.run('cuelga')).rejects.toBeInstanceOf(PsHostLost);
    const calls: string[] = [];
    const host2 = new PsHost(
      {},
      {
        timeoutMs: 40,
        spawnHost: () =>
          fakeChild((s, id, r, k) => (s.includes('cuelga') ? undefined : ok(s, id, r, k))).proc,
      },
    );
    const run = defaultRunner({}, host2, async (s) => {
      calls.push(s);
      return { stdout: '', stderr: '' };
    });
    const err = await run('cuelga').catch((e) => e);
    expect(powerShellWasCut(err)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('un error de script no activa el camino de siempre', async () => {
    const host = new PsHost({}, { spawnHost: () => fakeChild(ok).proc });
    const calls: string[] = [];
    const run = defaultRunner({}, host, async (s) => {
      calls.push(s);
      return { stdout: '', stderr: '' };
    });
    await expect(run('boom')).rejects.toThrow(/boom/);
    expect(calls).toEqual([]);
    host.close();
  });

  it('PA_PS_HOST=0 apaga el host', async () => {
    const run = defaultRunner({ PA_PS_HOST: '0' } as never, null, async (s) => ({
      stdout: `spawn:${s}`,
      stderr: '',
    }));
    expect((await run('y')).stdout).toBe('spawn:y');
  });

  it('tras 3 fallos de arranque se desactiva y mide la latencia de ambos modos', async () => {
    let spawned = 0;
    const host = new PsHost(
      {},
      {
        spawnHost: () => {
          spawned += 1;
          throw new Error('no');
        },
      },
    );
    const run = defaultRunner({}, host, async () => ({ stdout: 'ok', stderr: '' }));
    for (let i = 0; i < 5; i++) await run('z');
    expect(spawned).toBe(3);
    expect(psLatencySummary().spawn?.n).toBe(5);
    const good = new PsHost({}, { spawnHost: () => fakeChild(ok).proc });
    await defaultRunner({}, good, async () => ({ stdout: '', stderr: '' }))('a');
    expect(psLatencySummary().host?.n).toBe(1);
    good.close();
  });
});

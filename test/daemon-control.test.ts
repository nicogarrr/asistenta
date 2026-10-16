import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, it as baseIt, beforeEach, expect } from 'vitest';
import {
  type DaemonControl,
  openDaemonControl,
  requestDaemonControl,
} from '../src/daemon-control.js';

const it = process.platform === 'linux' ? baseIt : baseIt.skip;
let dir: string;
const controls: DaemonControl[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-ctl-'));
});
afterEach(async () => {
  for (const control of controls.splice(0)) await control.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});
async function ready(onStop = () => {}) {
  const ctl = await openDaemonControl(dir, onStop);
  controls.push(ctl);
  ctl.ready();
  return ctl;
}
function record() {
  return JSON.parse(readFileSync(join(dir, 'control', 'ready.json'), 'utf8'));
}
function address(id: string) {
  return join(dir, 'control', `${id.slice(0, 24)}.sock`);
}

it('authenticates status and never returns the secret/PID as authority', async () => {
  const ctl = await ready();
  expect(await requestDaemonControl(dir, 'status')).toEqual({
    instanceId: ctl.instanceId,
    state: 'READY',
  });
  const r = record();
  expect(JSON.stringify(await requestDaemonControl(dir, 'status'))).not.toContain(r.token);
});
it('serializes concurrent starts under an OS lock', async () => {
  const results = await Promise.allSettled([
    openDaemonControl(dir, () => {}),
    openDaemonControl(dir, () => {}),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  for (const r of results) if (r.status === 'fulfilled') controls.push(r.value);
});
it('accepts double stop once, and ACK only says STOPPING until close releases ownership', async () => {
  let stops = 0;
  const ctl = await ready(() => {
    stops++;
  });
  const answers = await Promise.all([
    requestDaemonControl(dir, 'stop'),
    requestDaemonControl(dir, 'stop'),
  ]);
  expect(answers.map((r) => r.state)).toEqual(['STOPPING', 'STOPPING']);
  expect(stops).toBe(1);
  await expect(openDaemonControl(dir, () => {})).rejects.toThrow('ocupado');
  await ctl.close();
  const next = await ready();
  expect(next.instanceId).not.toBe(ctl.instanceId);
  await ctl.close(); // Old cleanup cannot remove the next publication.
  expect((await requestDaemonControl(dir, 'status')).instanceId).toBe(next.instanceId);
});
it('does not publish until ready and never sends a signal to a recycled PID', async () => {
  const ctl = await openDaemonControl(dir, () => {});
  controls.push(ctl);
  expect(existsSync(join(dir, 'control', 'ready.json'))).toBe(false);
  ctl.ready();
  const r = record();
  r.pid = 1;
  writeFileSync(join(dir, 'control', 'ready.json'), JSON.stringify(r));
  expect((await requestDaemonControl(dir, 'status')).instanceId).toBe(ctl.instanceId);
});
it('rejects old tokens instead of stopping an endpoint with another identity', async () => {
  let stops = 0;
  await ready(() => {
    stops++;
  });
  const file = join(dir, 'control', 'ready.json');
  const original = readFileSync(file);
  const r = record();
  r.token = 'a'.repeat(64);
  writeFileSync(file, JSON.stringify(r));
  await expect(requestDaemonControl(dir, 'stop')).rejects.toThrow('autenticado');
  expect(stops).toBe(0);
  writeFileSync(file, original);
});
it('refuses unsafe state and symlink state', async () => {
  chmodSync(dir, 0o755);
  await expect(openDaemonControl(dir, () => {})).rejects.toThrow('Permisos');
  chmodSync(dir, 0o700);
  const alias = `${dir}-link`;
  symlinkSync(dir, alias);
  try {
    await expect(openDaemonControl(alias, () => {})).rejects.toThrow('Permisos');
  } finally {
    rmSync(alias);
  }
});
it('refuses symlink and open metadata', async () => {
  await ready();
  const file = join(dir, 'control', 'ready.json');
  const original = readFileSync(file);
  chmodSync(file, 0o644);
  await expect(requestDaemonControl(dir, 'status')).rejects.toThrow('Permisos');
  chmodSync(file, 0o600);
  rmSync(file);
  const target = join(dir, 'other');
  writeFileSync(target, original, { mode: 0o600 });
  symlinkSync(target, file);
  await expect(requestDaemonControl(dir, 'stop')).rejects.toThrow('Permisos');
});
it('refuses a socket with open permissions', async () => {
  const ctl = await ready();
  chmodSync(address(ctl.instanceId), 0o666);
  await expect(requestDaemonControl(dir, 'stop')).rejects.toThrow('Socket');
});
it('ignores arbitrary endpoint data and never connects TCP/UNC paths', async () => {
  const ctl = await ready();
  const r = record();
  r.endpoint = '\\\\remote\\pipe\\bad';
  writeFileSync(join(dir, 'control', 'ready.json'), JSON.stringify(r));
  expect((await requestDaemonControl(dir, 'status')).instanceId).toBe(ctl.instanceId);
});
it('closes oversize and slow clients with a bounded timeout', async () => {
  const ctl = await ready();
  for (const value of ['x'.repeat(4096), '{']) {
    const socket = createConnection(address(ctl.instanceId));
    await new Promise<void>((yes, no) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        no(new Error('client not bounded'));
      }, 3500);
      socket.on('error', () => {});
      socket.resume();
      socket.once('close', () => {
        clearTimeout(timeout);
        yes();
      });
      socket.once('connect', () => socket.write(value));
    });
  }
});
it('refuses an unauthenticated ACK even after a valid server challenge', async () => {
  const ctl = await ready();
  const r = record();
  await ctl.close();
  writeFileSync(join(dir, 'control', 'ready.json'), JSON.stringify(r), { mode: 0o600 });
  const mac = (...fields: string[]) =>
    createHmac('sha256', r.token)
      .update(JSON.stringify(['pa-control-v1', ...fields]))
      .digest('hex');
  const fake = createServer((s) => {
    const nonce = 'b'.repeat(64);
    s.write(
      `${JSON.stringify({ version: 1, instanceId: r.instanceId, nonce, proof: mac('challenge', r.instanceId, nonce) })}\n`,
    );
    s.once('data', () =>
      s.end(
        `${JSON.stringify({ version: 1, instanceId: r.instanceId, state: 'STOPPING', proof: '0'.repeat(64) })}\n`,
      ),
    );
  });
  await new Promise<void>((yes) => fake.listen(address(r.instanceId), yes));
  chmodSync(address(r.instanceId), 0o600);
  try {
    await expect(requestDaemonControl(dir, 'stop')).rejects.toThrow('Confirmación');
  } finally {
    await new Promise<void>((yes) => fake.close(() => yes()));
  }
});
it('releases kernel lock after a crash before or after READY', async () => {
  const source = pathToFileURL(resolve('src/daemon-control.ts')).href;
  for (const publish of [false, true]) {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {openDaemonControl} from ${JSON.stringify(source)};const c=await openDaemonControl(${JSON.stringify(dir)},()=>{});${publish ? 'c.ready();' : ''}console.log('ready');setInterval(()=>{},1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise<void>((yes, no) => {
      const timer = setTimeout(() => no(new Error('fixture did not start')), 5000);
      child.stdout.once('data', () => {
        clearTimeout(timer);
        yes();
      });
      child.once('exit', () => {
        clearTimeout(timer);
        no(new Error('fixture exited'));
      });
    });
    child.kill('SIGKILL'); // Only our freshly spawned fixture, never a stored PID.
    await new Promise<void>((yes) => child.once('exit', () => yes()));
    const next = await ready();
    expect((await requestDaemonControl(dir, 'status')).state).toBe('READY');
    await next.close();
  }
});

it('refuses stale metadata pointing at a regular file instead of unlinking it', async () => {
  const ctl = await ready();
  const r = record();
  await ctl.close();
  writeFileSync(address(r.instanceId), 'do not remove', { mode: 0o600 });
  writeFileSync(join(dir, 'control', 'ready.json'), JSON.stringify(r), { mode: 0o600 });
  await expect(openDaemonControl(dir, () => {})).rejects.toThrow('ambiguo');
  expect(readFileSync(address(r.instanceId), 'utf8')).toBe('do not remove');
});
it('does not remove metadata replaced by a different instance on old cleanup', async () => {
  const ctl = await ready();
  const r = record();
  r.instanceId = 'e'.repeat(64);
  writeFileSync(join(dir, 'control', 'ready.json'), JSON.stringify(r));
  await ctl.close();
  expect(record().instanceId).toBe(r.instanceId);
});
it('rejects replayed authenticated requests under a fresh challenge', async () => {
  let stopped = 0;
  const ctl = await ready(() => {
    stopped++;
  });
  const r = record();
  const exchange = (replay?: object) =>
    new Promise<{ request: object; answered: boolean }>((yes, no) => {
      const socket = createConnection(address(ctl.instanceId));
      socket.on('error', () => {});
      let request: object;
      let answered = false;
      const timeout = setTimeout(() => {
        socket.destroy();
        no(new Error('fixture timeout'));
      }, 3500);
      socket.once('data', (chunk) => {
        const c = JSON.parse(chunk.toString());
        const nonce = 'f'.repeat(64),
          action = 'status';
        request = replay ?? {
          version: 1,
          instanceId: ctl.instanceId,
          nonce,
          action,
          proof: createHmac('sha256', r.token)
            .update(
              JSON.stringify(['pa-control-v1', 'request', ctl.instanceId, c.nonce, nonce, action]),
            )
            .digest('hex'),
        };
        socket.write(`${JSON.stringify(request)}\n`);
        socket.once('data', () => {
          answered = true;
          clearTimeout(timeout);
          socket.destroy();
          yes({ request, answered });
        });
      });
      socket.once('close', () => {
        clearTimeout(timeout);
        if (!answered) replay ? yes({ request, answered }) : no(new Error('closed'));
      });
    });
  const first = await exchange();
  expect(first.answered).toBe(true);
  const replay = await exchange(first.request);
  expect(replay.answered).toBe(false);
  expect(stopped).toBe(0);
});
it('refuses malformed or oversized metadata without leaking file contents', async () => {
  await ready();
  const file = join(dir, 'control', 'ready.json');
  for (const value of ['secret-private-invalid-json', 'x'.repeat(4096)]) {
    writeFileSync(file, value);
    try {
      await requestDaemonControl(dir, 'status');
      throw new Error('unexpected success');
    } catch (error) {
      expect(String(error)).not.toContain(value);
      expect(String(error)).toMatch(/Metadata/);
    }
  }
});

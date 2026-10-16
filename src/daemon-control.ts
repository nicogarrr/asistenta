/** Linux-only local control. No PID signal, remote endpoint or Windows fallback. */
import { spawnSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';

type State = 'READY' | 'STOPPING';
type Action = 'status' | 'stop';
interface RecordV1 {
  version: 1;
  instanceId: string;
  token: string;
  pid: number;
}
const HEX = /^[a-f0-9]{64}$/;
const NONCE = () => randomBytes(32).toString('hex');
const LIMIT = 2048;
const TIMEOUT = 2000;

function supported(): void {
  if (process.platform !== 'linux')
    throw new Error('Control local solo disponible en Linux; Windows requiere DACL verificada.');
}
function ownedPrivate(path: string, directory: boolean): Stats {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    throw new Error('Permisos o propietario de control no seguros.');
  return stat;
}
function controlDir(stateDir: string): string {
  supported();
  const state = resolve(stateDir);
  ownedPrivate(state, true);
  const dir = join(state, 'control');
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  ownedPrivate(dir, true);
  return dir;
}
function recordAt(file: string): RecordV1 {
  const before = ownedPrivate(file, false);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = fstatSync(fd);
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size > LIMIT ||
      after.uid !== process.getuid?.() ||
      (after.mode & 0o077) !== 0
    )
      throw new Error('Metadata de control cambiada o demasiado grande.');
    let r: RecordV1;
    try {
      r = JSON.parse(readFileSync(fd, 'utf8')) as RecordV1;
    } catch {
      throw new Error('Metadata de control ilegible.');
    }
    if (
      r.version !== 1 ||
      !HEX.test(r.instanceId) ||
      !HEX.test(r.token) ||
      !Number.isSafeInteger(r.pid) ||
      r.pid <= 0
    )
      throw new Error('Metadata de control inválida.');
    return r;
  } finally {
    closeSync(fd);
  }
}
function endpoint(dir: string, id: string): string {
  const name = join(dir, `${id.slice(0, 24)}.sock`);
  if (Buffer.byteLength(name) > 100)
    throw new Error('Ruta de control demasiado larga para un socket Unix.');
  return name;
}
function mac(token: string, ...fields: string[]): string {
  return createHmac('sha256', token)
    .update(JSON.stringify(['pa-control-v1', ...fields]))
    .digest('hex');
}
function equal(a: unknown, b: string): boolean {
  return (
    typeof a === 'string' &&
    HEX.test(a) &&
    timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  );
}
function send(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}
function receive(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((yes, no) => {
    let bytes = 0;
    let text = '';
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      no(new Error('Control local sin respuesta a tiempo.'));
    }, TIMEOUT);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('error', error);
      socket.off('end', end);
    };
    const error = () => {
      cleanup();
      no(new Error('Conexión de control interrumpida.'));
    };
    const end = () => {
      cleanup();
      no(new Error('Respuesta de control incompleta.'));
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      text += chunk.toString('utf8');
      if (bytes > LIMIT) {
        cleanup();
        socket.destroy();
        no(new Error('Mensaje de control demasiado grande.'));
        return;
      }
      if (!text.includes('\n')) return;
      cleanup();
      try {
        if (text.indexOf('\n') !== text.length - 1) throw new Error();
        const value: unknown = JSON.parse(text.trim());
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        yes(value as Record<string, unknown>);
      } catch {
        socket.destroy();
        no(new Error('Protocolo de control inválido.'));
      }
    };
    socket.on('data', data);
    socket.once('error', error);
    socket.once('end', end);
  });
}
export interface DaemonControl {
  instanceId: string;
  /** Publish READY only after the daemon has finished startup. */
  ready(): void;
  /** Await shutdown completion before releasing OS ownership. */
  close(): Promise<void>;
}

export async function openDaemonControl(
  stateDir: string,
  onStop: () => void,
): Promise<DaemonControl> {
  const dir = controlDir(stateDir);
  const lock = join(dir, 'owner.lock');
  let locked = false;
  const id = NONCE();
  const token = NONCE();
  const address = endpoint(dir, id);
  const fd = openSync(lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const file = join(dir, 'ready.json');
  const temporary = join(dir, `${id}.tmp`);
  const clients = new Set<Socket>();
  let state: State = 'READY';
  let published = false;
  let closed = false;
  const lockStat = fstatSync(fd);
  const assertLock = () => {
    const live = ownedPrivate(lock, false);
    if (!locked || live.ino !== lockStat.ino || live.dev !== lockStat.dev)
      throw new Error('Se perdió la propiedad de control.');
  };
  const server = createServer((socket) => {
    // One request per connection; no multiplexing or unknown commands.
    if (!published || closed || clients.size >= 8) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.setTimeout(TIMEOUT, () => socket.destroy());
    socket.on('error', () => {});
    socket.once('close', () => clients.delete(socket));
    void (async () => {
      try {
        assertLock();
        const nonce = NONCE();
        const requestPromise = receive(socket);
        send(socket, {
          version: 1,
          instanceId: id,
          nonce,
          proof: mac(token, 'challenge', id, nonce),
        });
        const req = await requestPromise;
        if (
          req.version !== 1 ||
          req.instanceId !== id ||
          !HEX.test(String(req.nonce)) ||
          !['status', 'stop'].includes(String(req.action)) ||
          !equal(req.proof, mac(token, 'request', id, nonce, String(req.nonce), String(req.action)))
        )
          throw new Error('Control no autenticado.');
        assertLock();
        const current = recordAt(file);
        if (current.instanceId !== id || current.token !== token)
          throw new Error('Instancia de control sustituida.');
        const stop = req.action === 'stop' && state !== 'STOPPING';
        if (req.action === 'stop') state = 'STOPPING';
        socket.end(
          `${JSON.stringify({ version: 1, instanceId: id, state, proof: mac(token, 'ack', id, nonce, String(req.nonce), String(req.action), state) })}\n`,
        );
        // ACK means accepted, not stopped. Lifecycle remains responsible for draining.
        if (stop) onStop();
      } catch {
        socket.destroy();
      }
    })();
  });
  try {
    ownedPrivate(lock, false);
    const result = spawnSync('flock', ['--exclusive', '--nonblock', '4'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ignore', fd],
      timeout: 3000,
    });
    if (result.error || result.status !== 0)
      throw new Error('Control ocupado o flock no disponible; no se ha detenido ningún proceso.');
    locked = true;
    assertLock();
    // Under the OS lock only. A crash may leave metadata, not ownership.
    try {
      const previous = recordAt(file);
      const stale = endpoint(dir, previous.instanceId);
      try {
        const stat = lstatSync(stale);
        if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
          throw new Error('Socket anterior ambiguo.');
        unlinkSync(stale);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise<void>((yes, no) => {
      server.once('error', no);
      server.listen(address, () => {
        server.removeListener('error', no);
        yes();
      });
    });
    // chmod via an owned endpoint, never metadata-supplied paths.
    const { chmodSync } = await import('node:fs');
    chmodSync(address, 0o600);
  } catch (error) {
    server.close();
    closeSync(fd);
    throw error;
  }

  return {
    instanceId: id,
    ready() {
      if (closed || published) throw new Error('Control ya publicado o cerrado.');
      assertLock();
      writeFileSync(
        temporary,
        JSON.stringify({ version: 1, instanceId: id, token, pid: process.pid }),
        { flag: 'wx', mode: 0o600 },
      );
      renameSync(temporary, file);
      published = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const client of clients) client.destroy();
      await new Promise<void>((yes) => server.close(() => yes()));
      try {
        assertLock();
        if (published && recordAt(file).instanceId === id) unlinkSync(file);
      } finally {
        locked = false;
        closeSync(fd);
      }
    },
  };
}

export async function requestDaemonControl(
  stateDir: string,
  action: Action,
): Promise<{ instanceId: string; state: State }> {
  if (action !== 'status' && action !== 'stop') throw new Error('Acción de control no permitida.');
  const dir = controlDir(stateDir);
  const r = recordAt(join(dir, 'ready.json'));
  const address = endpoint(dir, r.instanceId);
  const stat = lstatSync(address);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error('Socket de control no seguro.');
  const socket = createConnection(address);
  socket.on('error', () => {});
  try {
    const challenge = await receive(socket);
    if (
      challenge.version !== 1 ||
      challenge.instanceId !== r.instanceId ||
      !HEX.test(String(challenge.nonce)) ||
      !equal(challenge.proof, mac(r.token, 'challenge', r.instanceId, String(challenge.nonce)))
    )
      throw new Error('Daemon no autenticado.');
    const nonce = NONCE();
    const response = receive(socket);
    send(socket, {
      version: 1,
      instanceId: r.instanceId,
      nonce,
      action,
      proof: mac(r.token, 'request', r.instanceId, String(challenge.nonce), nonce, action),
    });
    const ack = await response;
    if (
      ack.version !== 1 ||
      ack.instanceId !== r.instanceId ||
      !['READY', 'STOPPING'].includes(String(ack.state)) ||
      !equal(
        ack.proof,
        mac(
          r.token,
          'ack',
          r.instanceId,
          String(challenge.nonce),
          nonce,
          action,
          String(ack.state),
        ),
      )
    )
      throw new Error('Confirmación de control no autenticada.');
    const current = recordAt(join(dir, 'ready.json'));
    if (current.instanceId !== r.instanceId || current.token !== r.token)
      throw new Error('La instancia cambió durante la petición.');
    return { instanceId: r.instanceId, state: ack.state as State };
  } finally {
    socket.destroy();
  }
}

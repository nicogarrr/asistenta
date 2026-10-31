/** DACL-private local mailbox. No PID signals, HTTP, credentials or unauthenticated stop. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type DaemonControl, DaemonNotRunningError, isMissingFile } from './daemon-control.js';
import { windowsNative, windowsOwnership } from './windows-control-native.js';

const HEX = /^[a-f0-9]{64}$/;
const nonce = () => randomBytes(32).toString('hex');
interface RecordV1 {
  version: 1;
  instanceId: string;
  token: string;
  pid: number;
}
function mac(token: string, ...fields: string[]): string {
  return createHmac('sha256', token)
    .update(JSON.stringify(['pa-win-control-v1', ...fields]))
    .digest('hex');
}
function equal(value: unknown, expected: string): boolean {
  return (
    typeof value === 'string' &&
    HEX.test(value) &&
    timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'))
  );
}
function dir(state: string) {
  return join(state, 'control-win');
}
function read(state: string, leaf: string): Record<string, unknown> {
  const path = join(dir(state), leaf);
  const before = lstatSync(path);
  windowsNative(state, 'check', leaf);
  if (before.isSymbolicLink() || !before.isFile() || before.size > 2048)
    throw new Error('Metadata Windows inválida.');
  const text = readFileSync(path, 'utf8');
  const after = lstatSync(path);
  if (
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    text.length > 2048
  )
    throw new Error('Metadata Windows cambió durante lectura.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Metadata Windows ilegible.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Metadata Windows inválida.');
  return value as Record<string, unknown>;
}
function record(state: string): RecordV1 {
  const value = read(state, 'ready.json');
  if (
    value.version !== 1 ||
    typeof value.instanceId !== 'string' ||
    !HEX.test(value.instanceId) ||
    typeof value.token !== 'string' ||
    !HEX.test(value.token) ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0
  )
    throw new Error('Metadata Windows inválida.');
  return value as unknown as RecordV1;
}
function publish(state: string, leaf: string, value: unknown) {
  windowsNative(state, 'check');
  try {
    read(state, leaf);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporaryLeaf = `${nonce()}.tmp`;
  const temporary = join(dir(state), temporaryLeaf);
  // Create EMPTY first, then validate the inherited native DACL before writing a token.
  windowsNative(state, 'empty', temporaryLeaf);
  windowsNative(state, 'check', temporaryLeaf);
  writeFileSync(temporary, JSON.stringify(value), { flag: 'r+' });
  windowsNative(state, 'check', temporaryLeaf);
  renameSync(temporary, join(dir(state), leaf));
  windowsNative(state, 'check', leaf);
}
function removeOwned(state: string, leaf: string) {
  // Same ownership checks as read(), but the content is not parsed: a file left half-written
  // by a power cut is removed instead of blocking every later start.
  try {
    const path = join(dir(state), leaf);
    const stat = lstatSync(path);
    windowsNative(state, 'check', leaf);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Metadata Windows inválida.');
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export async function openWindowsDaemonControl(
  input: string,
  onStop: () => void,
): Promise<DaemonControl> {
  const state = resolve(input);
  windowsNative(state, 'init');
  const ownership = await windowsOwnership(state);
  let published = false;
  let closed = false;
  let stopping = false;
  let requestNonce: string | undefined;
  const id = nonce();
  const token = nonce();
  try {
    removeOwned(state, 'ready.json');
    removeOwned(state, 'request.json');
  } catch (error) {
    await ownership.release();
    throw error;
  }
  const timer = setInterval(() => {
    if (!published || closed || stopping) return;
    try {
      if (!ownership.alive()) throw new Error('Propiedad Windows perdida.');
      // One request is consumed per instance, so no replay can trigger a second drain.
      const request = read(state, 'request.json');
      if (
        request.instanceId !== id ||
        typeof request.nonce !== 'string' ||
        !HEX.test(request.nonce) ||
        !equal(request.proof, mac(token, 'stop', id, request.nonce))
      )
        throw new Error('Solicitud Windows no autenticada.');
      stopping = true;
      requestNonce = request.nonce;
      onStop();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Do not execute an ambiguous request. The caller times out, never claims success.
        console.error('Solicitud de control Windows rechazada; no se confirma parada.');
      }
    }
  }, 250);
  return {
    instanceId: id,
    ready() {
      if (closed || published || !ownership.alive())
        throw new Error('Control Windows no disponible.');
      publish(state, 'ready.json', { version: 1, instanceId: id, token, pid: process.pid });
      published = true;
    },
    async close(clean?: boolean) {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try {
        if (published) {
          const current = record(state);
          if (current.instanceId !== id || current.token !== token)
            throw new Error('Instancia Windows sustituida.');
          if (clean !== undefined && requestNonce)
            publish(state, `${id}.stopped`, {
              instanceId: id,
              nonce: requestNonce,
              clean,
              proof: mac(token, 'stopped', id, requestNonce, String(clean)),
            });
          removeOwned(state, 'ready.json');
        }
        if (clean !== false) await ownership.release();
        else {
          const fatal = setTimeout(() => process.exit(1), 15_000);
          fatal.unref();
        }
      } catch (error) {
        const fatal = setTimeout(() => process.exit(1), 15_000);
        fatal.unref();
        throw error;
      }
    },
  };
}
export async function stopWindowsDaemon(
  input: string,
  timeoutMs = 30_000,
): Promise<{ instanceId: string }> {
  const state = resolve(input);
  let original: RecordV1;
  try {
    original = record(state);
  } catch (error) {
    if (isMissingFile(error)) throw new DaemonNotRunningError();
    // A broken ready.json (power cut) with nobody owning control: nothing is running.
    if (
      error instanceof Error &&
      /^Metadata Windows (ilegible|inválida)\./.test(error.message) &&
      windowsNative(state, 'probe') !== 'busy'
    )
      throw new DaemonNotRunningError();
    throw error;
  }
  // Nobody holds the owner lock: a ready record left by a crash, nothing to stop.
  if (windowsNative(state, 'probe') !== 'busy') throw new DaemonNotRunningError();
  const requestNonce = nonce();
  publish(state, 'request.json', {
    instanceId: original.instanceId,
    nonce: requestNonce,
    proof: mac(original.token, 'stop', original.instanceId, requestNonce),
  });
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const proof = read(state, `${original.instanceId}.stopped`);
      if (
        proof.instanceId !== original.instanceId ||
        proof.nonce !== requestNonce ||
        proof.clean !== true ||
        !equal(
          proof.proof,
          mac(original.token, 'stopped', original.instanceId, requestNonce, 'true'),
        )
      )
        throw new Error('Cierre Windows no limpio o no autenticado.');
      if (windowsNative(state, 'confirm') === 'free') return { instanceId: original.instanceId };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(
    'Parada Windows no confirmada limpia a tiempo; no se ha matado ni relanzado ningún proceso.',
  );
}

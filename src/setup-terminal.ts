import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Interactive secrets go directly from the local TTY to the vault, never argv/history. */
export function terminalQuestion(prompt: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return Promise.reject(
      new Error(
        'pa setup requiere una terminal local interactiva; no pegues secretos en chats ni argumentos.',
      ),
    );
  return new Promise((yes, no) => {
    // For secret answers suppress every readline write, including cursor/control output.
    const muted = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const wasRaw = Boolean(process.stdin.isRaw);
    const rl = createInterface({
      input: process.stdin,
      output: secret ? muted : process.stdout,
      terminal: true,
    });
    let settled = false;
    const finish = (error?: Error, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('SIGTERM', terminate);
      process.removeListener('SIGHUP', terminate);
      rl.close();
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      if (secret) process.stdout.write('\n');
      error ? no(error) : yes(value);
    };
    const terminate = () =>
      finish(new Error('Configuración interrumpida; no se guardó esta entrada.'));
    process.once('SIGTERM', terminate);
    process.once('SIGHUP', terminate);
    const timer = setTimeout(
      () =>
        finish(new Error('Configuración cancelada por inactividad; no se guardó esta entrada.')),
      120_000,
    );
    rl.once('SIGINT', () =>
      finish(new Error('Configuración cancelada; no se guardó esta entrada.')),
    );
    rl.once('close', () => {
      if (!settled) finish(new Error('La entrada se cerró; no se guardó esta entrada.'));
    });
    if (secret) process.stdout.write(`${prompt} (entrada oculta): `);
    rl.question(secret ? '' : `${prompt}: `, (value) => finish(undefined, value));
  });
}

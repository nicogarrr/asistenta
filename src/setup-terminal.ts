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
  if (secret) return hiddenQuestion(prompt);
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

/** No readline/StringDecoder replacement or control-character normalization on secrets. */
function hiddenQuestion(prompt: string): Promise<string> {
  if (process.stdin.readableEncoding !== null)
    return Promise.reject(new Error('Entrada ya transformada; no se abre entrada secreta.'));
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = Boolean(input.isRaw);
    const wasFlowing = input.readableFlowing;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const chars: string[] = [];
    let cursor = 0;
    let received = 0;
    let sequence = '';
    let pasting = false;
    let ending = false;
    let settled = false;
    let enterTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(enterTimer);
      input.removeListener('data', data);
      input.removeListener('end', cancel);
      input.removeListener('error', cancel);
      process.removeListener('SIGTERM', cancel);
      process.removeListener('SIGHUP', cancel);
      input.setRawMode(wasRaw);
      if (wasFlowing !== true) input.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolve(chars.join(''));
      chars.fill('');
    };
    const cancel = () => finish(new Error('Entrada cancelada o no válida; no se guarda.'));
    const data = (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      // Count bytes before decoding/editing; backspace cannot evade the cap.
      if (!Buffer.isBuffer(chunk) || received > 16384 || ending) return cancel();
      try {
        if (chunk.includes(0) || chunk.includes(10)) return cancel();
        const decoded = decoder.decode(chunk, { stream: true });
        const points = [...decoded];
        for (let i = 0; i < points.length; i++) {
          const ch = points[i];
          if (ch === undefined) return cancel();
          if (sequence) {
            sequence += ch;
            const controls = ['\x1b[D', '\x1b[C', '\x1b[200~', '\x1b[201~'];
            if (!controls.some((x) => x.startsWith(sequence))) return cancel();
            if (controls.includes(sequence)) {
              if (sequence === '\x1b[D') cursor = Math.max(0, cursor - 1);
              if (sequence === '\x1b[C') cursor = Math.min(chars.length, cursor + 1);
              if (sequence === '\x1b[200~') {
                if (pasting) return cancel();
                pasting = true;
              }
              if (sequence === '\x1b[201~') {
                if (!pasting) return cancel();
                pasting = false;
              }
              sequence = '';
            }
          } else if (ch === '\x1b') sequence = ch;
          else if (ch === '\r') {
            if (pasting || i !== points.length - 1) return cancel();
            decoder.decode(); // Reject incomplete UTF-8, never replacement characters.
            ending = true;
            // Drain an immediately following paste chunk instead of carrying it
            // into the next question. A CR inside bracketed paste always fails.
            enterTimer = setTimeout(() => finish(), 30);
          } else if (ch === '\x7f' || ch === '\b') {
            if (pasting) return cancel();
            if (cursor) chars.splice(--cursor, 1);
          } else if ((ch.codePointAt(0) ?? 0) < 32) return cancel();
          else chars.splice(cursor++, 0, ch);
        }
      } catch {
        cancel();
      }
    };
    const timer = setTimeout(cancel, 120000);
    input.setRawMode(true);
    input.on('data', data);
    input.once('end', cancel);
    input.once('error', cancel);
    process.once('SIGTERM', cancel);
    process.once('SIGHUP', cancel);
    process.stdout.write(`${prompt} (entrada oculta): `);
    input.resume();
  });
}

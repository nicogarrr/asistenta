import type { Readable } from 'node:stream';

export const MAX_STDIN_SECRET_BYTES = 16_384;
const TIMEOUT_MS = 30_000;
class SecretInputError extends Error {}

/** Never echo or quote the secret in diagnostics. One final line ending is removed. */
type SecretInput = Readable & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };
const TTY_TIMEOUT_MS = 5 * 60_000;

export async function readSecretStdin(
  input: SecretInput,
  timeoutMs = TIMEOUT_MS,
  prompt: (text: string) => void = (text) => void process.stderr.write(text),
): Promise<string> {
  if (input.isTTY) {
    // Terminal con modo oculto (consola de Windows, terminal Linux): pide sin eco.
    if (typeof input.setRawMode === 'function')
      return readSecretTty(input, Math.max(timeoutMs, TTY_TIMEOUT_MS), prompt);
    throw new Error(
      'Usa una entrada privada por pipe, no una terminal con eco. No pegues el secreto aquí.',
    );
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const collect = async (): Promise<string> => {
    try {
      for await (const chunk of input) {
        const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk));
        bytes += buffer.length;
        if (bytes > MAX_STDIN_SECRET_BYTES) {
          buffer.fill(0);
          throw new SecretInputError('La entrada secreta supera el límite de 16 KiB.');
        }
        chunks.push(buffer);
      }
      const combined = Buffer.concat(chunks);
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(combined);
      } finally {
        combined.fill(0);
      }
      const value = decoded.replace(/\r?\n$/, '');
      if (!value || value.includes('\0') || value.includes('\n') || value.includes('\r'))
        throw new SecretInputError(
          'Se requiere un secreto no vacío de una sola línea, sin bytes nulos.',
        );
      return value;
    } catch (error) {
      if (error instanceof SecretInputError) throw error;
      throw new Error('No se pudo leer la entrada secreta.');
    }
  };
  try {
    return await Promise.race([
      collect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          input.destroy();
          reject(new Error('La entrada secreta no terminó en 30 segundos.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    for (const chunk of chunks) chunk.fill(0);
    // The string returned to the vault cannot be reliably erased by JavaScript.
  }
}

/** Lee una línea sin eco: retroceso borra, Ctrl+C cancela, Enter termina. */
function readSecretTty(
  input: SecretInput,
  timeoutMs: number,
  prompt: (text: string) => void,
): Promise<string> {
  prompt('Pega la clave y pulsa Enter (no se verá en pantalla): ');
  let chars: string[] = [];
  return new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error: Error | undefined, value?: string) => {
      if (timer) clearTimeout(timer);
      input.off('data', onData);
      input.off('error', onError);
      input.setRawMode?.(false);
      input.pause();
      prompt('\n');
      chars.fill('');
      if (error) reject(error);
      else resolve(value ?? '');
    };
    const onError = () => finish(new Error('No se pudo leer la entrada secreta.'));
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0003')
          return finish(new SecretInputError('Cancelado: no se ha guardado nada.'));
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          const value = chars.join('');
          if (!value || value.includes('\0'))
            return finish(
              new SecretInputError('Se requiere un secreto no vacío de una sola línea.'),
            );
          return finish(undefined, value);
        }
        if (ch === '\u007f' || ch === '\b') chars.pop();
        else chars.push(ch);
        if (chars.length > MAX_STDIN_SECRET_BYTES) {
          chars = [];
          return finish(new SecretInputError('La entrada secreta supera el límite de 16 KiB.'));
        }
      }
    };
    timer = setTimeout(
      () => finish(new Error('No se escribió la clave a tiempo; vuelve a intentarlo.')),
      timeoutMs,
    );
    input.setRawMode?.(true);
    input.on('data', onData);
    input.on('error', onError);
    input.resume();
  });
}

export async function setVaultFromStdin(
  args: string[],
  input: SecretInput,
  save: (key: string, value: string) => Promise<void>,
): Promise<void> {
  const [key] = args;
  if (args.length !== 1 || !key || !/^[a-zA-Z][a-zA-Z0-9:_.-]{0,127}$/.test(key))
    throw new Error(
      'uso: pa vault set-stdin <clave> (te la pide sin que se vea, o por pipe privado)',
    );
  const value = await readSecretStdin(input);
  try {
    await save(key, value);
  } catch {
    throw new Error('No se pudo guardar el secreto; comprueba el almacén y sus permisos.');
  }
}

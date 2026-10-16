import type { Readable } from 'node:stream';

export const MAX_STDIN_SECRET_BYTES = 16_384;
const TIMEOUT_MS = 30_000;

/** Never echo or quote the secret in diagnostics. One final line ending is removed. */
export async function readSecretStdin(
  input: Readable & { isTTY?: boolean },
  timeoutMs = TIMEOUT_MS,
): Promise<string> {
  if (input.isTTY)
    throw new Error(
      'Usa una entrada privada por pipe, no una terminal con eco. No pegues el secreto aquí.',
    );
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
          throw new Error('La entrada secreta supera el límite de 16 KiB.');
        }
        chunks.push(buffer);
      }
      const combined = Buffer.concat(chunks);
      let decoded: string;
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(combined);
      } finally {
        combined.fill(0);
      }
      const value = decoded.replace(/\r?\n$/, '');
      if (!value || value.includes('\0') || value.includes('\n') || value.includes('\r'))
        throw new Error('Se requiere un secreto no vacío de una sola línea, sin bytes nulos.');
      return value;
    } catch (error) {
      if (error instanceof Error && /^(La entrada secreta|Se requiere)/.test(error.message))
        throw error;
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

export async function setVaultFromStdin(
  args: string[],
  input: Readable & { isTTY?: boolean },
  save: (key: string, value: string) => Promise<void>,
): Promise<void> {
  const [key] = args;
  if (args.length !== 1 || !key || !/^[a-zA-Z][a-zA-Z0-9:_.-]{0,127}$/.test(key))
    throw new Error('uso: pa vault set-stdin <clave> (valor solo por pipe privado)');
  const value = await readSecretStdin(input);
  try {
    await save(key, value);
  } catch {
    throw new Error('No se pudo guardar el secreto; comprueba el almacén y sus permisos.');
  }
}

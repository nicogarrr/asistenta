/** Read-only rescue from #145. No login, install, service start or arbitrary shell input. */
import { randomBytes } from 'node:crypto';
import { createConnection, isIP } from 'node:net';

const MAX_BYTES = 32_768;
const DEADLINE_MS = 5_000;

export function diagnosticTarget(host: string, port = 23): void {
  const [a = -1, b = -1] = host.split('.').map(Number);
  if (
    isIP(host) !== 4 ||
    !(
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127)
    ) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Se requiere una IPv4 privada explícita y un puerto entre 1 y 65535.');
}

/** Minimal incremental Telnet framing: consume negotiation, never print protocol bytes. */
export class TelnetText {
  private state: 'text' | 'iac' | 'option' | 'sub' | 'sub-iac' = 'text';
  private operation = 0;
  feed(chunk: Buffer): { text: string; replies: Buffer } {
    const out: number[] = [];
    const replies: number[] = [];
    for (const byte of chunk) {
      switch (this.state) {
        case 'text':
          if (byte === 255) this.state = 'iac';
          else out.push(byte);
          break;
        case 'iac':
          if (byte === 250) this.state = 'sub';
          else if ([251, 252, 253, 254].includes(byte)) {
            this.operation = byte;
            this.state = 'option';
          } else {
            if (byte === 255) out.push(byte);
            this.state = 'text';
          }
          break;
        case 'option':
          if (this.operation === 251) replies.push(255, 254, byte);
          if (this.operation === 253) replies.push(255, 252, byte);
          this.state = 'text';
          break;
        case 'sub':
          if (byte === 255) this.state = 'sub-iac';
          break;
        case 'sub-iac':
          this.state = byte === 240 ? 'text' : 'sub';
          break;
      }
    }
    return { text: Buffer.from(out).toString('latin1'), replies: Buffer.from(replies) };
  }
}

export function diagnoseTv(host: string, port = 23): Promise<string> {
  diagnosticTarget(host, port);
  const marker = `PA_DIAG_END_${randomBytes(16).toString('hex')}`;
  // All shell text is fixed except a random hex marker. No host, path or password interpolation.
  const command = `id; uname -a; for t in python3 curl openssl sha256sum; do command -v "$t"; done; df -h /tmp /var /media; printf '\\n%s\\n' '${marker}'\n`;
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const parser = new TelnetText();
    let bytes = 0;
    let text = '';
    let sent = false;
    let settled = false;
    const finish = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(output ?? '');
    };
    const timer = setTimeout(
      () => finish(new Error('Diagnóstico agotó el plazo; no se confirma el resultado.')),
      DEADLINE_MS,
    );
    socket.on('error', () =>
      finish(new Error('No se pudo conectar al diagnóstico local de la TV.')),
    );
    socket.on('end', () => finish(new Error('La TV cerró sin completar el diagnóstico.')));
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        finish(new Error('Salida de diagnóstico demasiado grande.'));
        return;
      }
      const parsed = parser.feed(chunk);
      if (parsed.replies.length) socket.write(parsed.replies);
      text += parsed.text;
      if (!sent) {
        if (/login:|password:/i.test(text)) {
          finish(new Error('La TV pide credenciales; no se intenta iniciar sesión.'));
          return;
        }
        if (!/(?:^|[\r\n])[^\r\n]{0,80}[#$]\s*$/.test(text)) return;
        sent = true;
        text = '';
        socket.write(command);
        return;
      }
      const lines = text.replace(/\r/g, '').split('\n');
      const end = lines.indexOf(marker);
      if (end < 0) return;
      // Drop the echoed command and escape terminal control bytes in the report.
      const output = lines
        .slice(0, end)
        .filter((line) => !line.includes(marker))
        .join('\n');
      finish(
        undefined,
        Array.from(output, (c) => {
          const code = c.charCodeAt(0);
          return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)
            ? `\\x${code.toString(16).padStart(2, '0')}`
            : c;
        })
          .join('')
          .trim(),
      );
    });
  });
}

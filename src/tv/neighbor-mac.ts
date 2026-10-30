/**
 * `pa tv mac auto`: lee la MAC de la tele de la tabla de vecinos del sistema
 * (ARP) a partir de su IP ya emparejada. Primero un ping para que la entrada
 * exista; luego `arp -a <ip>` (Windows), `ip neigh show <ip>` (Linux) o
 * `arp -n <ip>` (macOS). Sin shell: argumentos fijos y la IP ya validada.
 */
import { execFile } from 'node:child_process';

export type RunCommand = (cmd: string, args: string[]) => Promise<string>;

const defaultRun: RunCommand = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024 }, (_e, stdout) =>
      resolve(String(stdout ?? '')),
    );
  });

const MAC_IN_TEXT = /\b([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})\b/i;

/** MAC (tal cual aparece) de la línea de la tabla de vecinos que nombra la IP, o null. */
export function macFromNeighborTable(output: string, ip: string): string | null {
  const ipRe = new RegExp(`(^|[^0-9.])${ip.replace(/\./g, '\\.')}([^0-9.]|$)`);
  for (const line of output.split(/\r?\n/)) {
    if (!ipRe.test(line)) continue;
    const m = MAC_IN_TEXT.exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

export async function readNeighborMac(
  ip: string,
  run: RunCommand = defaultRun,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const win = platform === 'win32';
  await run('ping', win ? ['-n', '1', '-w', '1000', ip] : ['-c', '1', '-W', '1', ip]);
  const out = win
    ? await run('arp', ['-a', ip])
    : platform === 'linux'
      ? await run('ip', ['neigh', 'show', ip])
      : await run('arp', ['-n', ip]);
  return macFromNeighborTable(out, ip);
}

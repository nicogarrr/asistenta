import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { type Account, listAccounts, realVault, revealPassword, type VaultOps } from './store.js';

/**
 * `pa cuentas`: lo único que enseña una contraseña, y solo en el propio PC.
 * - listar: igual que en el chat, sin contraseñas.
 * - copiar <web>: la pone en el portapapeles y lo vacía a los 30 s (nunca la imprime).
 * - exportar keepass|bitwarden <fichero>: CSV de KeePassXC o JSON de Bitwarden, en TEXTO
 *   PLANO, solo tras escribir EXPORTAR. Pensado para llevarlas a un gestor de verdad.
 * El modelo no tiene herramienta que llegue aquí.
 */

export interface CuentasCliDeps {
  vault?: VaultOps;
  out?: (s: string) => void;
  ask?: (question: string) => Promise<string>;
  copy?: (secret: string, clearAfterMs: number) => Promise<void>;
  write?: (path: string, data: string) => void;
}

const CSV_HEADER = 'Group,Title,Username,Password,URL,Notes';
const csv = (s: string): string => `"${s.replace(/"/g, '""')}"`;

export function toKeePassCsv(rows: Array<Account & { password: string }>): string {
  const lines = rows.map((r) =>
    ['Asistenta', r.domain, r.username, r.password, `https://${r.domain}`, r.notes]
      .map(csv)
      .join(','),
  );
  return `${[CSV_HEADER, ...lines].join('\r\n')}\r\n`;
}

export function toBitwardenJson(rows: Array<Account & { password: string }>): string {
  return `${JSON.stringify(
    {
      encrypted: false,
      folders: [],
      items: rows.map((r) => ({
        type: 1,
        name: r.domain,
        notes: r.notes || null,
        favorite: false,
        login: {
          username: r.username,
          password: r.password,
          uris: [{ match: null, uri: `https://${r.domain}` }],
        },
      })),
    },
    null,
    2,
  )}\n`;
}

/** Copia sin pasar el secreto por la línea de órdenes (va por stdin) y programa el borrado. */
export async function copyToClipboard(secret: string, clearAfterMs: number): Promise<void> {
  const win = process.platform === 'win32';
  const cmd = win ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
  const args = win || process.platform === 'darwin' ? [] : ['-selection', 'clipboard'];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('no pude usar el portapapeles')),
    );
    p.stdin.end(secret);
  });
  const secs = Math.round(clearAfterMs / 1000);
  const clear = win
    ? spawn(
        'powershell',
        ['-NoProfile', '-Command', `Start-Sleep ${secs}; Set-Clipboard -Value ' '`],
        {
          detached: true,
          stdio: 'ignore',
        },
      )
    : spawn('sh', ['-c', `sleep ${secs}; printf ' ' | ${[cmd, ...args].join(' ')}`], {
        detached: true,
        stdio: 'ignore',
      });
  clear.on('error', () => {});
  clear.unref();
}

async function askLine(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a);
    }),
  );
}

export async function cuentasCommand(argv: string[], deps: CuentasCliDeps = {}): Promise<number> {
  const vault = deps.vault ?? realVault;
  const out = deps.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const [sub = 'listar', a1, a2] = argv;
  if (sub === 'listar') {
    const all = await listAccounts(vault);
    if (all.length === 0) out('No hay cuentas guardadas.');
    for (const a of all)
      out(`${a.domain}  ${a.username}${a.status === 'pendiente' ? '  (sin terminar)' : ''}`);
    return 0;
  }
  if (sub === 'copiar' && a1) {
    const pw = await revealPassword(a1, vault);
    if (!pw) {
      out(`No tengo contraseña guardada de ${a1}.`);
      return 1;
    }
    await (deps.copy ?? copyToClipboard)(pw, 30_000);
    out('Contraseña copiada al portapapeles; se borra sola en 30 segundos.');
    return 0;
  }
  if (sub === 'exportar' && (a1 === 'keepass' || a1 === 'bitwarden') && a2) {
    out('Ojo: el fichero lleva TODAS tus contraseñas en texto plano. Impórtalo y bórralo.');
    const typed = await (deps.ask ?? askLine)('Escribe EXPORTAR para seguir: ');
    if (typed.trim() !== 'EXPORTAR') {
      out('Cancelado: no he escrito nada.');
      return 1;
    }
    const rows = [];
    for (const acc of await listAccounts(vault)) {
      const password = await revealPassword(acc.domain, vault);
      if (password && acc.status === 'activa') rows.push({ ...acc, password });
    }
    const data = a1 === 'keepass' ? toKeePassCsv(rows) : toBitwardenJson(rows);
    (deps.write ?? ((p, d) => writeFileSync(p, d, { mode: 0o600 })))(a2, data);
    out(`Exportadas ${rows.length} cuentas a ${a2}.`);
    return 0;
  }
  out('uso: pa cuentas [listar | copiar <web> | exportar keepass|bitwarden <fichero>]');
  return 2;
}

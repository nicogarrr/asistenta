import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { normalizeDomain } from '../gestor/login.js';
import { logFile } from '../log.js';
import { vaultExists } from '../vault.js';
import { oldPendingOffer, pendingAge } from './pending-age.js';
import { discardSignup, pendingOf } from './signup.js';
import {
  type Account,
  AvisoCuenta,
  deleteAccount,
  generatePassword,
  listAccounts,
  realVault,
  revealPassword,
  saveAccount,
  type VaultOps,
} from './store.js';

/**
 * `pa cuentas`: lo único que enseña una contraseña, y solo en el propio PC.
 * - listar: igual que en el chat, sin contraseñas.
 * - copiar <web>: la pone en el portapapeles y lo vacía a los 30 s (nunca la imprime).
 * - exportar keepass|bitwarden <fichero>: CSV de KeePassXC o JSON de Bitwarden, en TEXTO
 *   PLANO, solo tras escribir EXPORTAR. Pensado para llevarlas a un gestor de verdad.
 * - borrar <web>: la quita del gestor tras escribir el nombre de la web.
 * - cambiar <web>: guarda otra contraseña (escrita sin verse, dos veces, o una fuerte
 *   nueva al portapapeles) tras escribir CAMBIAR.
 * El modelo no tiene herramienta que llegue aquí; borrar y cambiar exigen además una
 * terminal de verdad (no una tubería), para que nadie las conteste por él.
 */

export interface CuentasCliDeps {
  vault?: VaultOps;
  out?: (s: string) => void;
  ask?: (question: string) => Promise<string>;
  /** Pregunta sin mostrar lo que se escribe (contraseñas). */
  askHidden?: (question: string) => Promise<string>;
  /** ¿Hay una persona delante (stdin es una terminal)? */
  isTty?: boolean;
  copy?: (secret: string, clearAfterMs: number) => Promise<void>;
  write?: (path: string, data: string) => void;
  /** ¿Existe ya la caja fuerte de claves? (en una instalación nueva, todavía no). */
  vaultExists?: () => boolean;
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

async function askHiddenLine(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const iface = rl as unknown as { _writeToOutput: (s: string) => void };
  let asked = false;
  iface._writeToOutput = (s: string) => {
    if (!asked) {
      asked = true;
      process.stdout.write(s);
    }
  };
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    }),
  );
}

const NEEDS_TTY =
  'Esto solo se hace a mano, desde una ventana de terminal en el PC (no por una tubería ni desde el chat).';

/**
 * La cuenta de la consola: la web exacta, o el nombre a secas («wallapop») si solo encaja
 * una (la misma regla que en el chat). Con varias, pide la exacta; nunca mezcla dominios.
 */
async function cuentaDe(
  site: string,
  vault: VaultOps,
  out: (s: string) => void,
): Promise<Account | null> {
  const all = await listAccounts(vault);
  const domain = normalizeDomain(site);
  const exact = all.find((a) => a.domain === domain);
  if (exact) return exact;
  const hits =
    domain && !domain.includes('.') ? all.filter((a) => a.domain.split('.').includes(domain)) : [];
  if (hits.length === 1) return hits[0] ?? null;
  out(
    hits.length > 1
      ? `Tengo varias que encajan con «${site}»: ${hits.map((a) => a.domain).join(', ')}. Escribe la web exacta.`
      : `No tengo ninguna cuenta guardada de ${site}.`,
  );
  return null;
}

/** `pa cuentas descartar <web>`: quita un alta a medias, solo con el nombre exacto tecleado. */
async function descartar(
  site: string,
  vault: VaultOps,
  deps: CuentasCliDeps,
  out: (s: string) => void,
) {
  let p: Account | null;
  try {
    p = await pendingOf(site, vault, true);
  } catch (err) {
    if (err instanceof AvisoCuenta) {
      out(err.message);
      return 1;
    }
    throw err;
  }
  if (!p) {
    out(
      `No hay ningún alta a medias de ${site}. Una cuenta ya terminada se quita con pa cuentas borrar <web>.`,
    );
    return 1;
  }
  if (!deps.ask && !(deps.isTty ?? process.stdin.isTTY)) {
    out(NEEDS_TTY);
    return 1;
  }
  const age = pendingAge(p);
  out(
    `Vas a descartar el alta a medias de ${p.domain}${age ? ` (${age})` : ''}: se borra la contraseña que preparé. Si la cuenta llegó a crearse en la web, allí sigue.`,
  );
  const typed = await (deps.ask ?? askLine)(`Escribe ${p.domain} para descartarla: `);
  if (typed.trim().toLowerCase() !== p.domain) {
    out('Cancelado: no he descartado nada.');
    return 1;
  }
  await discardSignup(p.domain, vault);
  out(`Descartada el alta a medias de ${p.domain}.`);
  return 0;
}

async function borrar(
  site: string,
  vault: VaultOps,
  deps: CuentasCliDeps,
  out: (s: string) => void,
) {
  const acc = await cuentaDe(site, vault, out);
  if (!acc) return 1;
  if (!deps.ask && !(deps.isTty ?? process.stdin.isTTY)) {
    out(NEEDS_TTY);
    return 1;
  }
  out(
    `Vas a quitar ${acc.domain} (${acc.username}) del gestor. La cuenta en la web sigue existiendo.`,
  );
  const typed = await (deps.ask ?? askLine)(`Escribe ${acc.domain} para borrarla: `);
  if (typed.trim().toLowerCase() !== acc.domain) {
    out('Cancelado: no he borrado nada.');
    return 1;
  }
  await deleteAccount(acc.domain, vault);
  out(`Borrada ${acc.domain} del gestor.`);
  return 0;
}

async function cambiar(
  site: string,
  vault: VaultOps,
  deps: CuentasCliDeps,
  out: (s: string) => void,
) {
  const found = await cuentaDe(site, vault, out);
  if (!found) return 1;
  const acc = found.status === 'activa' ? found : null;
  if (!acc) {
    out(`No tengo ninguna cuenta guardada de ${site}.`);
    return 1;
  }
  if (!(deps.ask && deps.askHidden) && !(deps.isTty ?? process.stdin.isTTY)) {
    out(NEEDS_TTY);
    return 1;
  }
  const hidden = deps.askHidden ?? askHiddenLine;
  const first = await hidden('Nueva contraseña (no se ve; vacío = genero una fuerte): ');
  let password = first;
  if (first) {
    if ((await hidden('Repítela: ')) !== first) {
      out('No coinciden: no he cambiado nada.');
      return 1;
    }
  } else {
    password = generatePassword();
  }
  const typed = await (deps.ask ?? askLine)(
    `Escribe CAMBIAR para guardar la nueva de ${acc.domain}: `,
  );
  if (typed.trim() !== 'CAMBIAR') {
    out('Cancelado: no he cambiado nada.');
    return 1;
  }
  await saveAccount(
    { site: acc.domain, username: acc.username, password, notes: acc.notes },
    vault,
  );
  if (first) {
    out(`Contraseña de ${acc.domain} cambiada en el gestor.`);
  } else {
    await (deps.copy ?? copyToClipboard)(password, 60_000);
    out(
      `Nueva contraseña de ${acc.domain} guardada y copiada al portapapeles (se borra en 60 s): ponla ya en la web.`,
    );
  }
  return 0;
}

export const CUENTAS_USO =
  'No conozco esa orden. Usa: pa cuentas listar (tus cuentas), pa cuentas copiar <web> (copia la contraseña), pa cuentas borrar <web>, pa cuentas cambiar <web>, pa cuentas descartar <web> (un alta a medias) o pa cuentas exportar keepass|bitwarden <fichero>.';

/** Como se dice de palabra: «pa cuentas lista», «copia wallapop», «borra …». */
const ALIAS: Record<string, string> = {
  lista: 'listar',
  ver: 'listar',
  copia: 'copiar',
  borra: 'borrar',
  cambia: 'cambiar',
  exporta: 'exportar',
  descarta: 'descartar',
};

export const CUENTAS_GESTOR_KO =
  'Ahora mismo no puedo leer tu gestor de contraseñas. Prueba otra vez en un momento; si sigue igual, `pa doctor` te dice qué le pasa.';

export const CUENTAS_SIN_CAJA =
  'Todavía no tienes caja fuerte de claves, así que no hay cuentas guardadas. Se crea al instalar (doble clic en instalar.bat) o con pa vault init.';

export async function cuentasCommand(argv: string[], deps: CuentasCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  try {
    return await cuentasRun(argv, deps, out);
  } catch (err) {
    // Instalación nueva sin caja fuerte: no es un fallo ni se arregla «probando otra vez».
    const exists = deps.vaultExists ?? (deps.vault ? () => true : vaultExists);
    if (!safeExists(exists)) {
      out(CUENTAS_SIN_CAJA);
      const sub = (argv[0] ?? 'listar').toLowerCase();
      return sub === 'listar' || ALIAS[sub] === 'listar' ? 0 : 1;
    }
    // Un fallo del gestor (vault ilegible, disco…): una línea llana; el detalle, solo al registro.
    logFile.warn('pa cuentas: fallo del gestor de contraseñas', {
      error: err instanceof Error ? err.message : String(err),
    });
    out(CUENTAS_GESTOR_KO);
    return 1;
  }
}

const safeExists = (exists: () => boolean): boolean => {
  try {
    return exists();
  } catch {
    return true;
  }
};

async function cuentasRun(
  argv: string[],
  deps: CuentasCliDeps,
  out: (s: string) => void,
): Promise<number> {
  const vault = deps.vault ?? realVault;
  const [rawSub = 'listar', a1, a2] = argv;
  const sub = ALIAS[rawSub.toLowerCase()] ?? rawSub.toLowerCase();
  // Una orden conocida a la que le falta la web no es «no conozco esa orden».
  if (['copiar', 'borrar', 'cambiar', 'descartar'].includes(sub) && !a1) {
    out(`Falta la web: pa cuentas ${sub} <web>, por ejemplo pa cuentas ${sub} wallapop.es.`);
    return 2;
  }
  if (sub === 'exportar' && a1 !== 'keepass' && a1 !== 'bitwarden') {
    out(
      '¿A qué formato? Usa: pa cuentas exportar keepass <fichero> o pa cuentas exportar bitwarden <fichero>.',
    );
    return 2;
  }
  if (sub === 'exportar' && !a2) {
    out(
      `Falta el fichero: pa cuentas exportar ${a1} <fichero>, por ejemplo ${a1 === 'keepass' ? 'cuentas.csv' : 'cuentas.json'}.`,
    );
    return 2;
  }
  if (sub === 'listar') {
    const all = await listAccounts(vault);
    if (all.length === 0) out('No hay cuentas guardadas.');
    for (const a of all)
      out(
        `${a.domain}  ${a.username}${a.status === 'pendiente' ? `  (sin terminar${pendingAge(a) ? `, ${pendingAge(a)}` : ''})` : ''}`,
      );
    const offer = oldPendingOffer(all, Date.now(), true);
    if (offer) out(offer);
    return 0;
  }
  if (sub === 'copiar' && a1) {
    const acc = await cuentaDe(a1, vault, out);
    const pw = acc ? await revealPassword(acc.domain, vault) : undefined;
    if (!acc) return 1;
    if (!pw) {
      out(`No tengo contraseña guardada de ${acc.domain}.`);
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
  if (sub === 'borrar' && a1) return borrar(a1, vault, deps, out);
  if (sub === 'cambiar' && a1) return cambiar(a1, vault, deps, out);
  if (sub === 'descartar' && a1) return descartar(a1, vault, deps, out);
  out(CUENTAS_USO);
  return 2;
}

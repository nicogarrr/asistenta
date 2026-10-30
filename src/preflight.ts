/**
 * `pa iniciar`: comprobación de arranque antes de levantar el daemon.
 *
 * Antes, `pa serve` fallaba de uno en uno (sin vault, sin token, sin usuarios…)
 * con una línea en inglés, y lo opcional (tele, correo, Computer Use, disco) no
 * se miraba hasta que Nico lo usaba. Aquí se repasa todo de una vez y se pinta
 * una lista en español, verde/rojo, con el arreglo de cada fallo al lado.
 *
 * Todo lo que toca el mundo (vault, red, tele, disco) llega inyectado en
 * `PreflightDeps`, así que los tests no abren nada real.
 */

export type CheckStatus = 'ok' | 'aviso' | 'fallo' | 'info';

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Qué hacer para arreglarlo (solo en aviso/fallo). */
  hint?: string;
}

export interface PreflightDeps {
  nodeVersion: string;
  platform: NodeJS.Platform;
  vaultExists(): boolean;
  /** Abre el vault; lanza si no se puede. */
  unlock(): Promise<void>;
  vaultGet(key: string): Promise<string | null | undefined>;
  /** Lanza con un mensaje en español si el token no vale o no hay red. */
  checkTelegramToken(token: string): Promise<void>;
  /** Prepara el proveedor del modelo sin gastar llamadas; lanza si faltan claves. */
  checkProvider(): Promise<void>;
  /** Mensaje en español para un fallo de checkProvider. */
  providerFailureMessage(error: unknown): string;
  /** ¿Responde la tele en `host`? (conexión TCP corta; nunca manda órdenes). */
  tvReachable(host: string): Promise<boolean>;
  desktopEnabled(): boolean;
  computerUseEnabled(): boolean;
  mailStatus(): Promise<{ read: string; send: string }>;
  /** Bytes libres en la carpeta de estado, o null si no se puede saber. */
  freeDiskBytes(): Promise<number | null>;
  /** Sin red: no se valida el token contra Telegram ni se mira la tele. */
  offline?: boolean;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`;
}

/** Repasa todo. Nunca lanza: cada comprobación que revienta sale como fallo. */
export async function runPreflight(deps: PreflightDeps): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => checks.push(c);

  const major = Number(/^v?(\d+)/.exec(deps.nodeVersion)?.[1] ?? 0);
  add(
    major >= 24
      ? { id: 'node', label: 'Node', status: 'ok', detail: deps.nodeVersion }
      : {
          id: 'node',
          label: 'Node',
          status: 'fallo',
          detail: `${deps.nodeVersion}: hace falta la 24 o más nueva`,
          hint: 'Instala Node 24 LTS desde nodejs.org y vuelve a abrir la terminal.',
        },
  );

  let vaultOpen = false;
  if (!deps.vaultExists()) {
    add({
      id: 'vault',
      label: 'Caja fuerte (vault)',
      status: 'fallo',
      detail: 'no existe todavía',
      hint: 'pa vault init (o pa setup para el asistente guiado)',
    });
  } else {
    try {
      await deps.unlock();
      vaultOpen = true;
      add({ id: 'vault', label: 'Caja fuerte (vault)', status: 'ok', detail: 'abierta' });
    } catch (error) {
      add({
        id: 'vault',
        label: 'Caja fuerte (vault)',
        status: 'fallo',
        detail: `no se puede abrir: ${errorText(error).slice(0, 120)}`,
        hint: 'Comprueba que es el mismo usuario de Windows que la creó.',
      });
    }
  }
  const get = async (key: string): Promise<string | undefined> =>
    vaultOpen
      ? ((await deps.vaultGet(key).catch(() => undefined))?.trim() ?? undefined)
      : undefined;

  // Telegram: token y usuarios. Sin ellos `pa serve` no arranca.
  const token = await get('telegram:botToken');
  if (!token) {
    add({
      id: 'telegram',
      label: 'Telegram',
      status: 'fallo',
      detail: 'falta el token del bot',
      hint: 'pa vault set telegram:botToken <token de @BotFather>',
    });
  } else if (deps.offline) {
    add({
      id: 'telegram',
      label: 'Telegram',
      status: 'info',
      detail: 'token guardado (sin comprobar: --sin-red)',
    });
  } else {
    try {
      await deps.checkTelegramToken(token);
      add({ id: 'telegram', label: 'Telegram', status: 'ok', detail: 'el bot responde' });
    } catch (error) {
      add({
        id: 'telegram',
        label: 'Telegram',
        status: 'fallo',
        detail: errorText(error).slice(0, 160),
        hint: 'Revisa la red o el token con @BotFather y repite pa iniciar.',
      });
    }
  }
  const allowed = (await get('telegram:allowedUserIds'))
    ?.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  add(
    allowed?.length
      ? {
          id: 'usuarios',
          label: 'Usuarios autorizados',
          status: 'ok',
          detail: `${allowed.length}`,
        }
      : {
          id: 'usuarios',
          label: 'Usuarios autorizados',
          status: 'fallo',
          detail: 'no hay ninguno',
          hint: 'pa vault set telegram:allowedUserIds <tu id de Telegram>',
        },
  );

  // Modelo: mismas claves que usa pa serve, sin ninguna llamada de pago.
  try {
    await deps.checkProvider();
    add({ id: 'modelo', label: 'Modelo', status: 'ok', detail: 'claves listas' });
  } catch (error) {
    add({
      id: 'modelo',
      label: 'Modelo',
      status: 'fallo',
      detail: deps.providerFailureMessage(error),
      hint: 'pa vault set provider:apiKey <clave> (o pa llm-health para probar cada proveedor)',
    });
  }

  // Tele: opcional. Solo se mira si está emparejada.
  const tvHost = await get('tv:host');
  if (!tvHost) {
    add({ id: 'tele', label: 'Tele', status: 'info', detail: 'no emparejada (opcional)' });
  } else if (deps.offline) {
    add({
      id: 'tele',
      label: 'Tele',
      status: 'info',
      detail: `${tvHost} (sin comprobar: --sin-red)`,
    });
  } else {
    const ok = await deps.tvReachable(tvHost).catch(() => false);
    add(
      ok
        ? { id: 'tele', label: 'Tele', status: 'ok', detail: `responde en ${tvHost}` }
        : {
            id: 'tele',
            label: 'Tele',
            status: 'aviso',
            detail: `no responde en ${tvHost}`,
            hint: 'Enciéndela (o activa «Encender con móvil» en la LG) y comprueba que está en la misma wifi; pa tv estado para más detalle.',
          },
    );
  }

  // PC / Computer Use.
  if (!deps.desktopEnabled()) {
    add({
      id: 'pc',
      label: 'PC (Computer Use)',
      status: 'info',
      detail: 'modo servidor (PA_DESKTOP=off)',
    });
  } else if (deps.platform !== 'win32') {
    add({
      id: 'pc',
      label: 'PC (Computer Use)',
      status: 'aviso',
      detail: 'el control del PC solo funciona en Windows',
      hint: 'En este equipo pon PA_DESKTOP=off en .env.',
    });
  } else if (!deps.computerUseEnabled()) {
    add({
      id: 'pc',
      label: 'PC (Computer Use)',
      status: 'aviso',
      detail: 'apagado (PA_COMPUTER_USE=0)',
      hint: 'Actívalo desde Telegram con /ordenador on.',
    });
  } else {
    add({
      id: 'pc',
      label: 'PC (Computer Use)',
      status: 'ok',
      detail: 'activado; pide permiso antes de tocar',
    });
  }

  // Correo: opcional.
  const mail = await deps.mailStatus().catch(() => ({ read: 'falta', send: 'falta' }));
  if (mail.read === 'ok' && mail.send === 'ok') {
    add({ id: 'correo', label: 'Correo', status: 'ok', detail: 'lectura y envío configurados' });
  } else if (mail.read === 'falta' && mail.send === 'falta') {
    add({ id: 'correo', label: 'Correo', status: 'info', detail: 'sin configurar (opcional)' });
  } else {
    add({
      id: 'correo',
      label: 'Correo',
      status: 'aviso',
      detail: `lectura: ${mail.read}, envío: ${mail.send}`,
      hint: 'Escribe /correo estado en Telegram: dice qué falta y cómo ponerlo.',
    });
  }

  // Disco: el estado, la memoria y las copias viven en la carpeta de estado.
  const free = await deps.freeDiskBytes().catch(() => null);
  if (free === null) {
    add({ id: 'disco', label: 'Disco', status: 'info', detail: 'no he podido medirlo' });
  } else if (free < 200 * MB) {
    add({
      id: 'disco',
      label: 'Disco',
      status: 'fallo',
      detail: `${formatBytes(free)} libres`,
      hint: 'Libera espacio: con el disco lleno no se guardan recordatorios ni memoria.',
    });
  } else if (free < GB) {
    add({
      id: 'disco',
      label: 'Disco',
      status: 'aviso',
      detail: `${formatBytes(free)} libres`,
      hint: 'Conviene liberar espacio pronto.',
    });
  } else {
    add({ id: 'disco', label: 'Disco', status: 'ok', detail: `${formatBytes(free)} libres` });
  }

  return checks;
}

/** 0 = puede arrancar (aunque haya avisos); 1 = algo impide arrancar. */
export function preflightExitCode(checks: readonly PreflightCheck[]): 0 | 1 {
  return checks.some((c) => c.status === 'fallo') ? 1 : 0;
}

const ICON: Record<CheckStatus, string> = { ok: '✅', aviso: '⚠️', fallo: '❌', info: '·' };
const COLOR: Record<CheckStatus, string> = {
  ok: '\x1b[32m',
  aviso: '\x1b[33m',
  fallo: '\x1b[31m',
  info: '\x1b[2m',
};

/** La lista para la terminal. `color` solo si la salida es una terminal y no hay NO_COLOR. */
export function formatPreflight(
  checks: readonly PreflightCheck[],
  opts: { color?: boolean } = {},
): string {
  const paint = (status: CheckStatus, text: string) =>
    opts.color ? `${COLOR[status]}${text}\x1b[0m` : text;
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines = ['Asistenta — comprobación de arranque', ''];
  for (const c of checks) {
    lines.push(paint(c.status, `${ICON[c.status]} ${c.label.padEnd(width)}  ${c.detail}`));
    if (c.hint && (c.status === 'fallo' || c.status === 'aviso')) lines.push(`   → ${c.hint}`);
  }
  const fails = checks.filter((c) => c.status === 'fallo').length;
  const warns = checks.filter((c) => c.status === 'aviso').length;
  lines.push('');
  if (fails) {
    lines.push(
      paint(
        'fallo',
        `${fails} ${fails === 1 ? 'problema impide' : 'problemas impiden'} arrancar${warns ? ` y hay ${warns} ${warns === 1 ? 'aviso' : 'avisos'}` : ''}.`,
      ),
    );
  } else {
    lines.push(
      paint(
        warns ? 'aviso' : 'ok',
        warns
          ? `Lista para arrancar, con ${warns} ${warns === 1 ? 'aviso' : 'avisos'}.`
          : 'Todo listo para arrancar.',
      ),
    );
  }
  return lines.join('\n');
}

// Instalador de Asistenta para un PC nuevo (pensado para Windows; vale en Linux).
// Uso: doble clic en instalar.bat, o `node scripts/instalar.mjs`.
// Hace, en orden: comprueba Node 24+, `npm ci`, `npm run build`, crea .env y
// guarda en la caja fuerte el token de Telegram, la clave del modelo y tu ID de
// Telegram. Los secretos van por `pa vault set-stdin` (nunca en la línea de
// órdenes ni en pantalla). Sin dependencias: corre antes de `npm ci`.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const NODE_MIN = 24;
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/** Versión mayor de Node, o 0 si no se entiende. */
export function nodeMajor(version) {
  const n = Number(String(version).replace(/^v/, '').split('.')[0]);
  return Number.isInteger(n) ? n : 0;
}

/** Preset del modelo escrito en .env (o el de por defecto). */
export function presetFromEnv(text) {
  const m = /^\s*PA_PROVIDER_PRESET\s*=\s*["']?([\w-]+)/m.exec(text ?? '');
  return m?.[1] ?? 'opencode';
}

/**
 * ¿La carpeta está dentro de OneDrive? OneDrive bloquea archivos mientras los sube y
 * `npm ci` / la compilación fallan con EPERM o EBUSY. Mira las variables que pone
 * Windows (OneDrive, OneDriveConsumer, OneDriveCommercial) y, si faltan, el nombre.
 */
export function enOneDrive(dir, env = {}) {
  const norm = (p) =>
    String(p ?? '')
      .replace(/\//g, '\\')
      .replace(/\\+$/, '')
      .toLowerCase();
  const d = norm(dir);
  if (!d) return false;
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const r = norm(env[k]);
    if (r && (d === r || d.startsWith(`${r}\\`))) return true;
  }
  return /\\onedrive( - [^\\]+)?(\\|$)/.test(d);
}

export const ONEDRIVE_MOVER =
  'Mueve la carpeta de Asistenta fuera de OneDrive, por ejemplo a C:\\Asistenta, y abre instalar.bat desde allí.';

/**
 * Espera el primer mensaje privado que el dueño manda a SU bot y lo devuelve.
 * Marca la actualización como leída para que Asistenta no la conteste luego.
 */
export async function waitOwnerMessage(fetchFn, token, { tries = 6 } = {}) {
  const base = `https://api.telegram.org/bot${token}`;
  for (let i = 0; i < tries; i++) {
    const res = await fetchFn(`${base}/getUpdates?timeout=20&allowed_updates=%5B%22message%22%5D`);
    if (res.status === 401 || res.status === 404) return { error: 'token' };
    if (res.status === 409) return { error: 'ocupado' };
    if (!res.ok) return { error: 'red' };
    const body = await res.json();
    const upd = (body.result ?? []).find(
      (u) => u.message?.chat?.type === 'private' && u.message.from,
    );
    if (upd) {
      await fetchFn(`${base}/getUpdates?offset=${upd.update_id + 1}&timeout=0`);
      const f = upd.message.from;
      const name = [f.first_name, f.last_name].filter(Boolean).join(' ') || 'sin nombre';
      return { id: String(f.id), who: f.username ? `${name} (@${f.username})` : name };
    }
  }
  return { error: 'tiempo' };
}

/** Pasos del instalador. Todo lo que toca el sistema llega en `d` (tests). */
export async function instalar(d) {
  const say = (s) => d.write(`${s}\n`);
  const fail = (s) => {
    say(`✗ ${s}`);
    return 1;
  };

  if (nodeMajor(d.nodeVersion) < NODE_MIN)
    return fail(
      `Necesitas Node ${NODE_MIN} o más nuevo y tienes ${d.nodeVersion}. Descárgalo gratis de https://nodejs.org, instálalo y vuelve a abrir instalar.bat.`,
    );
  say(`✓ Node ${d.nodeVersion}`);

  const oneDrive = enOneDrive(d.cwd, d.env);
  if (oneDrive)
    say(
      `⚠ Asistenta está dentro de OneDrive (${d.cwd}). OneDrive bloquea archivos mientras sincroniza y la instalación suele fallar. ${ONEDRIVE_MOVER}`,
    );

  say('… Instalando dependencias (npm ci). Tarda unos minutos.');
  if ((await d.run('npm', ['ci', '--no-audit', '--no-fund'])) !== 0)
    return fail(
      oneDrive
        ? `No se han podido instalar las dependencias: OneDrive tenía archivos bloqueados. ${ONEDRIVE_MOVER}`
        : 'No se han podido instalar las dependencias. Mira tu conexión a internet y vuelve a abrir instalar.bat. Si arriba pone EPERM o EBUSY, otro programa (el antivirus, un editor u otra ventana de Asistenta) tiene archivos abiertos: ciérralo y prueba otra vez. Si se repite, borra la carpeta node_modules y prueba otra vez.',
    );
  say('… Compilando.');
  if ((await d.run('npm', ['run', 'build'])) !== 0)
    return fail(
      oneDrive
        ? `No se ha podido compilar: OneDrive tenía archivos bloqueados. ${ONEDRIVE_MOVER}`
        : 'No se ha podido compilar. Descarga Asistenta otra vez (o haz git pull si la clonaste) y vuelve a abrir instalar.bat.',
    );
  say('✓ Programa listo');

  if (d.exists('.env')) say('✓ .env ya existe; no lo toco');
  else if (d.exists('.env.example')) {
    d.copy('.env.example', '.env');
    say('✓ Creado .env con las opciones de serie');
  } else return fail('Falta el archivo .env.example. Vuelve a descargar el proyecto completo.');

  let saved = await d.vaultList();
  if (saved === null && (await d.cli(['vault', 'init'])) === 0) saved = await d.vaultList();
  if (saved === null)
    return fail(
      'No he podido crear la caja fuerte de claves. Abre instalar.bat con tu usuario normal (no «Ejecutar como administrador») y prueba otra vez.',
    );
  const has = (k) => saved.includes(k);
  const store = async (key, value) => {
    if ((await d.vaultSet(key, value)) !== 0) throw new Error(key);
  };

  try {
    let token = '';
    for (let i = 0; i < 3 && !token; i++) {
      const raw = (
        await d.ask(
          has('telegram:botToken')
            ? 'Token del bot de Telegram (ya guardado; Enter para mantenerlo): '
            : 'Pega el token de tu bot de Telegram (te lo da @BotFather al crear el bot con /newbot): ',
          { secret: true },
        )
      ).trim();
      if (!raw && has('telegram:botToken')) break;
      if (TOKEN_RE.test(raw)) token = raw;
      else
        say(
          '✗ Eso no parece un token de bot. Es algo como 123456789:AAH… y lo copias del chat con @BotFather.',
        );
    }
    if (!token && !has('telegram:botToken'))
      return fail(
        'Sin el token de Telegram Asistenta no puede hablar contigo. Vuelve a abrir instalar.bat cuando lo tengas.',
      );
    if (token) {
      await store('telegram:botToken', token);
      say('✓ Token de Telegram guardado');
    }

    if (presetFromEnv(d.readEnv()) === 'opencode-local') say('✓ Modelo local: no hace falta clave');
    else {
      const key = (
        await d.ask(
          has('provider:apiKey')
            ? 'Clave del modelo (ya guardada; Enter para mantenerla): '
            : 'Pega la clave del modelo (lo único de pago; la sacas de tu cuenta del proveedor, p. ej. opencode.ai): ',
          { secret: true },
        )
      ).trim();
      if (key) {
        await store('provider:apiKey', key);
        say('✓ Clave del modelo guardada');
      } else if (!has('provider:apiKey'))
        return fail(
          'Sin la clave del modelo Asistenta no puede contestar. Vuelve a abrir instalar.bat cuando la tengas.',
        );
    }

    if (has('telegram:allowedUserIds') && !token) say('✓ Tu ID de Telegram ya estaba guardado');
    else {
      let id = '';
      // Token recién pegado o, si ya estaba guardado, el de la caja fuerte (no se enseña).
      const botToken =
        token ||
        (has('telegram:botToken') && d.vaultGet ? await d.vaultGet('telegram:botToken') : '');
      if (botToken) {
        say('→ Abre Telegram y mándale «hola» a tu bot. Te espero un par de minutos…');
        const got = await waitOwnerMessage(d.fetch, botToken);
        if (got.error === 'token')
          return fail(
            token
              ? 'Telegram dice que ese token no vale. Cópialo otra vez de @BotFather y repite.'
              : 'Telegram dice que el token guardado ya no vale. Vuelve a abrir instalar.bat y pega el token nuevo de @BotFather.',
          );
        if (got.error === 'ocupado')
          return fail(
            'Asistenta ya está encendida con este bot. Apágala (node dist\\cli.js stop) y repite.',
          );
        if (got.id) {
          const yes = (await d.ask(`He recibido un mensaje de ${got.who}. ¿Eres tú? (s/n): `))
            .trim()
            .toLowerCase();
          if (yes.startsWith('s')) id = got.id;
        }
      }
      while (!id) {
        const typed = (
          await d.ask('Escribe tu ID de Telegram (solo números; Enter para dejarlo): ')
        ).trim();
        if (!typed)
          return fail(
            'Falta tu ID de Telegram: sin él Asistenta no sabe quién eres. Vuelve a abrir instalar.bat.',
          );
        if (/^\d{3,15}$/.test(typed)) id = typed;
        else say('✗ El ID son solo números, por ejemplo 123456789.');
      }
      await store('telegram:allowedUserIds', id);
      say('✓ Tu ID de Telegram guardado: solo tú podrás hablar con Asistenta');
    }
  } catch {
    return fail(
      'No he podido guardar una clave en la caja fuerte. Vuelve a abrir instalar.bat; si se repite, reinicia el PC.',
    );
  }

  say('');
  say('Listo. Para encender Asistenta: doble clic en levantar.bat.');
  say('Para que arranque sola con Windows: node dist\\cli.js autostart install --start');
  return 0;
}

/** Pregunta por consola; con `secret` no se ve lo que escribes. */
function ask(question, { secret = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (secret) rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? question : '');
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (secret) process.stdout.write('\n');
      resolve(answer);
    }),
  );
}

const win = process.platform === 'win32';
// `shell` solo hace falta para npm (npm.cmd en Windows). Con shell, una ruta con
// espacios sin comillas se rompe: «C:\Program Files\nodejs\node.exe» → «'C:\Program'
// no se reconoce…». Por eso node (process.execPath) va siempre sin shell.
export const makeRun =
  (spawnFn = spawn, isWin = win) =>
  (cmd, args, { shell = isWin } = {}) =>
    new Promise((resolve) => {
      const p = spawnFn(cmd, args, { stdio: 'inherit', shell });
      p.on('error', () => resolve(1));
      p.on('close', (code) => resolve(code ?? 1));
    });
const run = makeRun();
const cliArgs = (args) => ['dist/cli.js', ...args];
export const cliWith =
  (runFn, exe = process.execPath) =>
  (args) =>
    runFn(exe, cliArgs(args), { shell: false });

export const realDeps = {
  nodeVersion: process.version,
  cwd: process.cwd(),
  env: process.env,
  write: (s) => process.stdout.write(s),
  run,
  exists: existsSync,
  copy: copyFileSync,
  readEnv: () => (existsSync('.env') ? readFileSync('.env', 'utf8') : ''),
  cli: cliWith(run),
  vaultList: async () => {
    const r = spawnSync(process.execPath, cliArgs(['vault', 'list']), { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : null;
  },
  // Lee una clave guardada por una tubería: nunca sale en pantalla.
  vaultGet: async (key) => {
    const r = spawnSync(process.execPath, cliArgs(['vault', 'get', key]), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return r.status === 0 ? r.stdout.trim() : '';
  },
  vaultSet: (key, value) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, cliArgs(['vault', 'set-stdin', key]), {
        stdio: ['pipe', 'ignore', 'inherit'],
      });
      p.on('error', () => resolve(1));
      p.on('close', (code) => resolve(code ?? 1));
      p.stdin.end(value);
    }),
  ask,
  fetch: (url) => fetch(url, { signal: AbortSignal.timeout(30_000) }),
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await instalar(realDeps);
}

/** Pagina local de setup del userbot de libros (SOLO 127.0.0.1, con token).
 *
 * Defensas (dictamen de auditoria, 11-oct-2026):
 * - URL con token aleatorio (?k=...): sin token no hay ni GET; el token se
 *   muestra en la terminal de asistenta al arrancar el setup.
 * - Host estricto 127.0.0.1:puerto y Origin (si viene) del mismo origen:
 *   una web abierta en su navegador no puede hacer POST aqui (CSRF/rebinding).
 * - api_id/api_hash validados (digitos / hex-32): sin inyeccion de lineas .env.
 * - Mensajes escapados en HTML: un error de Telegram no inyecta markup.
 * - .env escrito y chmod 0600 explicito siempre.
 * - Un solo LoginFlow en memoria con caducidad; se limpia al completar.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { envFileText } from '../env-text.js';
import { uniqueTmpPath } from '../fs-tmp.js';
import { log } from '../log.js';
import { configFromEnv, LoginFlow } from './userbot.js';

const ENV_PATH = process.env.BOOKS_ENV_PATH ?? '.env';
const PHONE = process.env.BOOKS_TG_PHONE ?? '';

export function generateSetupToken(): string {
  return randomBytes(24).toString('hex');
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Formato de app password de Google: 16 letras (se muestran en grupos de 4). */
export function validGmailInputs(address: string, appPassword: string): boolean {
  return (
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim()) &&
    /^[a-z]{16}$/i.test(appPassword.replaceAll(' ', ''))
  );
}

export function validCredentialFormats(apiId: string, apiHash: string): boolean {
  // Sin \n posible: los formatos no lo admiten.
  return /^\d{1,12}$/.test(apiId) && /^[a-f0-9]{32}$/i.test(apiHash);
}

export function isAllowedRequest(req: IncomingMessage, port: number, token: string): boolean {
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${port}`) return false;
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.searchParams.get('k') !== token) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) return false;
  return true;
}

const PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Libros - setup Telegram</title>
<style>body{font-family:sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}
input,button{font-size:1rem;padding:.5rem;margin:.25rem 0;width:100%}</style></head>
<body>
<h1>Libros: conectar tu Telegram</h1>
<ol>
<li>Copia <b>api_id</b> y <b>api_hash</b> desde tu app Instinct (vault) y pegalos aqui.</li>
<li>Pulsa <b>Guardar y pedir codigo</b>: Telegram te manda un codigo al movil.</li>
<li>Escribe el codigo y pulsa <b>Entrar</b>. Solo se hace una vez.</li>
</ol>
<form method="post" action="/setup?k=TOKEN">
<label>api_id <input name="api_id" inputmode="numeric" autocomplete="off"></label>
<label>api_hash <input name="api_hash" autocomplete="off"></label>
<button>Guardar y pedir codigo</button>
</form>
<h2>Correo para enviar al Kindle</h2>
<form method="post" action="/gmail?k=TOKEN">
<label>Tu Gmail <input name="gmail_address" type="email" autocomplete="off"></label>
<label>App password de Google (16 letras) <input name="app_password" type="password" autocomplete="off"></label>
<button>Verificar y guardar correo</button>
</form>
<form method="post" action="/login?k=TOKEN">
<label>Codigo de Telegram <input name="code" inputmode="numeric" autocomplete="one-time-code"></label>
<label>Contrasena 2FA (solo si la tienes activa) <input name="password" type="password" autocomplete="off"></label>
<button>Entrar</button>
</form>
<p>MSG</p>
</body></html>`;

/**
 * Escribe las dos claves en el .env de Nico, que guarda TODAS sus claves.
 * - Atómico (temporal + rename): un corte a medias (disco lleno, cierre) dejaba
 *   el .env truncado y se perdían todas las claves, no solo estas dos.
 * - Respeta el resto del fichero: líneas en blanco, CRLF de Windows y BOM.
 * - Sustituye todas las apariciones de la clave (también `export CLAVE=`), para
 *   que una línea repetida más abajo no siga mandando con el valor viejo.
 */
export function saveCredsToEnv(apiId: string, apiHash: string, envPath = ENV_PATH): void {
  // Como el arranque: un .env con BOM o en UTF-16 (PowerShell 5 «>») se lee bien
  // y se reescribe en UTF-8; leído como utf8 se corrompía entero.
  const raw = existsSync(envPath) ? envFileText(readFileSync(envPath)) : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw === '' ? [] : raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const set = (key: string, value: string) => {
    const isKey = (l: string) => {
      const t = l.trimStart();
      return t.startsWith(`${key}=`) || t.startsWith(`export ${key}=`);
    };
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (!isKey(lines[i] as string)) continue;
      lines[i] = found ? '' : `${key}=${value}`;
      found = true;
    }
    if (!found) lines.push(`${key}=${value}`);
  };
  set('BOOKS_TG_API_ID', apiId);
  set('BOOKS_TG_API_HASH', apiHash);
  const tmp = uniqueTmpPath(envPath);
  try {
    writeFileSync(tmp, `${lines.join(eol)}${eol}`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, envPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  chmodSync(envPath, 0o600);
}

export interface SetupDeps {
  /** Perezoso: el flujo (y la lectura de credenciales del env) nace con el
   * primer requestCode, NUNCA al arrancar el server: la pagina existe justo
   * para introducir credenciales que aun no estan.
   * fresh: las credenciales acaban de cambiar - descarta el flow anterior
   * (con su config vieja) y construye uno nuevo; los cambios se serializan. */
  getFlow: (opts?: { fresh?: boolean }) => Promise<Pick<LoginFlow, 'requestCode' | 'complete'>>;
  token: string;
  port: number;
  phone?: string;
  /** Verifica el app password contra SMTP de Gmail ANTES de guardar (lanza si falla). */
  verifySmtp: (address: string, appPassword: string) => Promise<void>;
  /** Guarda la cuenta en el vault local de asistenta (0600). */
  saveMail: (address: string, appPassword: string) => Promise<void>;
}

export function makeSetupHandler(deps: SetupDeps) {
  const phone = deps.phone ?? PHONE;
  // Mutex por OPERACION completa (guardar credenciales + recrear flow +
  // requestCode, o complete): una segunda peticion espera a que la primera
  // termine del todo. Sin esto, un segundo /setup podia hacer dispose del
  // flow mientras el primero estaba a mitad del requestCode.
  let opChain: Promise<void> = Promise.resolve();
  const runExclusive = (op: () => Promise<void>): Promise<void> => {
    const run = opChain.then(op);
    opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const render = (res: ServerResponse, msg: string, status = 200) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      // La pagina lleva el token en la URL y secretos en formularios: nada
      // de cache del navegador ni de referrer que los filtre a terceros.
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end(PAGE.replaceAll('TOKEN', deps.token).replace('MSG', escapeHtml(msg)));
  };
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (!isAllowedRequest(req, deps.port, deps.token)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    if (req.method === 'GET') {
      render(res, 'Pagina lista.');
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      void runExclusive(async () => {
        try {
          const form = Object.fromEntries(new URLSearchParams(body));
          const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
          if (path === '/setup') {
            const apiId = form.api_id ?? '';
            const apiHash = form.api_hash ?? '';
            if (!validCredentialFormats(apiId, apiHash)) {
              render(res, 'Formato invalido: api_id numerico y api_hash hex de 32.', 400);
              return;
            }
            if (!phone) {
              render(res, 'Falta BOOKS_TG_PHONE en el entorno de asistenta.', 500);
              return;
            }
            saveCredsToEnv(apiId, apiHash);
            process.env.BOOKS_TG_API_ID = apiId;
            process.env.BOOKS_TG_API_HASH = apiHash;
            await (await deps.getFlow({ fresh: true })).requestCode(phone);
            render(res, 'Codigo pedido: revisa Telegram en tu movil.');
          } else if (path === '/gmail') {
            const address = (form.gmail_address ?? '').trim();
            const appPassword = (form.app_password ?? '').replaceAll(' ', '');
            if (!validGmailInputs(address, appPassword)) {
              render(res, 'Formato invalido: Gmail y app password de 16 letras.', 400);
              return;
            }
            try {
              await deps.verifySmtp(address, appPassword);
            } catch {
              render(
                res,
                'Google rechazo el inicio de sesion SMTP: revisa que sea un app password de ESTA cuenta (necesita 2FA activo).',
                502,
              );
              return;
            }
            try {
              await deps.saveMail(address, appPassword);
            } catch {
              // Error generico: el detalle del vault puede llevar datos
              // sensibles y NO vuelve al navegador.
              render(
                res,
                'No se pudo guardar el correo en el vault local. Intentalo de nuevo.',
                500,
              );
              return;
            }
            render(res, 'Correo verificado y guardado.');
          } else if (path === '/login') {
            await (await deps.getFlow()).complete(
              (form.code ?? '').trim(),
              form.password?.trim() || undefined,
            );
            render(res, 'Sesion guardada. Ya puedes cerrar esta pagina.');
          } else {
            render(res, 'Ruta desconocida.', 404);
          }
        } catch (err) {
          // El error crudo de Telegram («PHONE_CODE_INVALID», «FLOOD_WAIT_60») solo al registro.
          log.warn('books setup: paso fallido', { err: String(err) });
          render(res, setupFailureText(err), 500);
        }
      });
    });
  };
}

/** Motivo llano de un paso fallido de la página; nunca el texto crudo del error. */
export function setupFailureText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/PHONE_CODE_(INVALID|EXPIRED|EMPTY)/i.test(raw)) {
    return 'El código no es válido o ha caducado. Pide otro y vuelve a intentarlo.';
  }
  if (/PASSWORD|SRP/i.test(raw)) {
    return 'Falta la contraseña de verificación en dos pasos de Telegram, o no es correcta.';
  }
  if (/FLOOD/i.test(raw)) return 'Telegram pide esperar un rato antes de volver a intentarlo.';
  return 'No se pudo completar este paso con Telegram. Inténtalo de nuevo en un momento.';
}

export function startSetupServer(port = 8377): {
  server: Server;
  token: string;
  url: string;
  /** Resuelve cuando el puerto escucha DE VERDAD; rechaza (p.ej. EADDRINUSE) si no. */
  ready: Promise<void>;
} {
  const token = generateSetupToken();
  // Sin LoginFlow aqui: sin credenciales configuradas todavia, construirlo
  // lanzaria error y la pagina nunca abriria (huevo-y-gallina).
  let flow: LoginFlow | undefined;
  // Reconfiguracion: un /setup con credenciales nuevas desecha el flow viejo
  // (su config readonly quedaria antigua). Los swaps van en cadena: dos POST
  // concurrentes no dejan dos clientes vivos ni un flow a medias.
  let swap: Promise<void> = Promise.resolve();
  const getFlow = async (opts?: { fresh?: boolean }): Promise<LoginFlow> => {
    if (opts?.fresh) {
      const step = swap.then(async () => {
        const old = flow;
        flow = undefined;
        if (old) await old.dispose();
      });
      swap = step;
      await step;
    }
    if (!flow) {
      flow = new LoginFlow(configFromEnv(process.env));
    }
    return flow;
  };
  const server = createServer(
    makeSetupHandler({
      getFlow,
      token,
      port,
      verifySmtp: async (address, appPassword) => {
        const { verifyGmailSmtp } = await import('./setup-gmail.js');
        await verifyGmailSmtp(address, appPassword);
      },
      saveMail: async (address, appPassword) => {
        const { vaultSetMany } = await import('../vault.js');
        // Una sola escritura para la pareja: nunca queda address nueva con
        // password vieja. Limite honesto: escritores de OTRO proceso sobre
        // el vault compartido no se serializan con esta operacion.
        await vaultSetMany({ 'mail:address': address, 'mail:password': appPassword });
      },
    }),
  );
  // Anunciar la URL antes del listening prometia un server que podia no
  // existir: ready separa "creado" de "escuchando".
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  // Si el llamador ignora ready, que un fallo de listen no explote como
  // unhandledRejection: quien lo espera sigue recibiendo el rechazo.
  void ready.catch(() => undefined);
  server.listen(port, '127.0.0.1');
  return { server, token, url: `http://127.0.0.1:${port}/?k=${token}`, ready };
}

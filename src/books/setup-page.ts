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
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
<form method="post" action="/login?k=TOKEN">
<label>Codigo de Telegram <input name="code" inputmode="numeric" autocomplete="one-time-code"></label>
<label>Contrasena 2FA (solo si la tienes activa) <input name="password" type="password" autocomplete="off"></label>
<button>Entrar</button>
</form>
<p>MSG</p>
</body></html>`;

function saveCredsToEnv(apiId: string, apiHash: string): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const set = (key: string, value: string) => {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  };
  set('BOOKS_TG_API_ID', apiId);
  set('BOOKS_TG_API_HASH', apiHash);
  writeFileSync(ENV_PATH, `${lines.filter((l) => l.trim()).join('\n')}\n`, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
}

export interface SetupDeps {
  flow: Pick<LoginFlow, 'requestCode' | 'complete'>;
  token: string;
  port: number;
  phone?: string;
}

export function makeSetupHandler(deps: SetupDeps) {
  const phone = deps.phone ?? PHONE;
  const render = (res: ServerResponse, msg: string, status = 200) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
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
      void (async () => {
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
            await deps.flow.requestCode(phone);
            render(res, 'Codigo pedido: revisa Telegram en tu movil.');
          } else if (path === '/login') {
            await deps.flow.complete((form.code ?? '').trim(), form.password?.trim() || undefined);
            render(res, 'Sesion guardada. Ya puedes cerrar esta pagina.');
          } else {
            render(res, 'Ruta desconocida.', 404);
          }
        } catch (err) {
          render(res, `Error: ${err instanceof Error ? err.message : String(err)}`, 500);
        }
      })();
    });
  };
}

export function startSetupServer(port = 8377): { server: Server; token: string; url: string } {
  const token = generateSetupToken();
  const flow = new LoginFlow(configFromEnv(process.env));
  const server = createServer(makeSetupHandler({ flow, token, port }));
  server.listen(port, '127.0.0.1');
  return { server, token, url: `http://127.0.0.1:${port}/?k=${token}` };
}

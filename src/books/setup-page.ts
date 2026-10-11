/** Pagina local de setup del userbot de libros (127.0.0.1, solo su PC).
 *
 * Flujo para Nico, sin terminal: abre la pagina -> pega api_id/api_hash desde
 * su app Instinct -> "Pedir codigo" -> Telegram le manda el codigo al movil ->
 * lo pega -> sesion guardada (0600). Las credenciales viajan de su portapapeles
 * a su .env local; nunca por chat ni logs. El servidor solo escucha en loopback.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { completeLogin, configFromEnv, type PendingLogin, requestLoginCode } from './userbot.js';

const ENV_PATH = process.env.BOOKS_ENV_PATH ?? '.env';
const PHONE = process.env.BOOKS_TG_PHONE ?? '';

const PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Libros - setup Telegram</title>
<style>body{font-family:sans-serif;max-width:32rem;margin:2rem auto;padding:0 1rem}
input,button{font-size:1rem;padding:.5rem;margin:.25rem 0;width:100%}</style></head>
<body>
<h1>Libros: conectar tu Telegram</h1>
<ol>
<li>Copia <b>api_id</b> y <b>api_hash</b> desde tu app Instinct (vault) y pegalos aqui.</li>
<li>Pulsa <b>Guardar y pedir codigo</b>: Telegram te manda un codigo al movil.</li>
<li>Escribe el codigo y pulsa <b>Entrar</b>. Listo, solo se hace una vez.</li>
</ol>
<form method="post" action="/setup">
<label>api_id <input name="api_id" inputmode="numeric" autocomplete="off"></label>
<label>api_hash <input name="api_hash" autocomplete="off"></label>
<button>Guardar y pedir codigo</button>
</form>
<form method="post" action="/login">
<label>Codigo de Telegram <input name="code" inputmode="numeric" autocomplete="one-time-code"></label>
<label>Contraseña 2FA (solo si la tienes activa) <input name="password" type="password" autocomplete="off"></label>
<button>Entrar</button>
</form>
<p>MSG</p>
</body></html>`;

function render(msg: string): string {
  return PAGE.replace('MSG', msg);
}

function parseForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

function saveCredsToEnv(apiId: string, apiHash: string): void {
  // Sustituye o añade las dos claves en el .env local (0600 lo crea userbot).
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
  const set = (key: string, value: string) => {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  };
  set('BOOKS_TG_API_ID', apiId);
  set('BOOKS_TG_API_HASH', apiHash);
  writeFileSync(ENV_PATH, lines.filter((l) => l.trim()).join('\n') + '\n', {
    mode: 0o600,
  });
}

let pending: PendingLogin | undefined;

export function startSetupServer(port = 8377): Server {
  return createServer((req, res) => {
    const send = (html: string, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(render(html));
    };
    if (req.method === 'GET') {
      send('Pagina lista.');
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      void (async () => {
        try {
          const form = parseForm(body);
          if (req.url === '/setup') {
            saveCredsToEnv(form.api_id ?? '', form.api_hash ?? '');
            process.env.BOOKS_TG_API_ID = form.api_id;
            process.env.BOOKS_TG_API_HASH = form.api_hash;
            if (!PHONE) {
              send('Credenciales guardadas, pero falta BOOKS_TG_PHONE en el entorno.');
              return;
            }
            pending = await requestLoginCode(configFromEnv(process.env), PHONE);
            send('Codigo pedido: revisa Telegram en tu movil.');
          } else if (req.url === '/login') {
            if (!pending) {
              send('Primero pulsa Guardar y pedir codigo.', 400);
              return;
            }
            await completeLogin(
              configFromEnv(process.env),
              pending,
              (form.code ?? '').trim(),
              form.password?.trim() || undefined,
            );
            send('Sesion guardada. Ya puedes cerrar esta pagina.');
          } else {
            send('Ruta desconocida.', 404);
          }
        } catch (err) {
          send(`Error: ${err instanceof Error ? err.message : String(err)}`, 500);
        }
      })();
    });
  }).listen(port, '127.0.0.1');
}

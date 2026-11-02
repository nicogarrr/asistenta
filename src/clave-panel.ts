/**
 * Campo «Clave de OpenCode Go» de la tarjeta Estado del panel: guarda la clave
 * en el almacén (provider:apiKey) SIN terminal. La comprueba en vivo contra Go
 * antes de guardarla: un typo se detecta al momento y no deja a Asistenta
 * sin modelo (2-nov-2026: una clave vieja en el almacén dejó a Nico bloqueado
 * tras pasar a opencode-go y la única vía era `pa vault set-stdin`).
 * La clave nunca se escribe en logs ni se devuelve al panel.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { envFileText } from './env-text.js';
import { dotEnvFiles } from './envfile.js';

export interface AplicarClaveDeps {
  setKey?: (key: string, value: string) => Promise<void>;
  fetchFn?: typeof fetch;
  /** El entorno vivo (process.env): OPENCODE_GO_API_KEY manda sobre el almacén. */
  env?: Record<string, string | undefined>;
  /** Los .env que se cargan al arrancar (dotEnvFiles). */
  files?: string[];
  readFile?: (path: string) => Buffer;
  writeFile?: (path: string, text: string) => void;
}

const ENV_GO_KEY = 'OPENCODE_GO_API_KEY';
const ENV_GO_KEY_LINE = /^[ \t]*OPENCODE_GO_API_KEY[ \t]*=[^\r\n]*/gm;

/**
 * La env OPENCODE_GO_API_KEY manda sobre el almacén (core/provider.ts): con ella
 * puesta, la clave nueva del panel quedaría tapada por la vieja. Se comenta su
 * línea en los .env que la tengan (la clave pasa a vivir solo en el almacén,
 * cifrada) y se quita del proceso vivo. Devuelve una nota para el usuario, o ''.
 */
function retirarClaveEnv(deps: AplicarClaveDeps): string {
  const env = deps.env ?? process.env;
  if (!env[ENV_GO_KEY]?.trim()) return '';
  delete env[ENV_GO_KEY];
  const read = deps.readFile ?? ((p: string) => readFileSync(p));
  const write = deps.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));
  let enArchivo = false;
  for (const file of deps.files ?? dotEnvFiles()) {
    let texto: string;
    try {
      texto = envFileText(read(file));
    } catch {
      continue;
    }
    if (!new RegExp(ENV_GO_KEY_LINE.source, 'm').test(texto)) continue;
    enArchivo = true;
    try {
      write(
        file,
        texto.replace(
          ENV_GO_KEY_LINE,
          '# OPENCODE_GO_API_KEY= (quitada: la clave de Go está en el almacén, puesta desde el panel)',
        ),
      );
    } catch {
      return ` Ojo: no pude quitar ${ENV_GO_KEY} de ${file}; bórrala a mano o, al reiniciar, volvería a mandar la vieja.`;
    }
  }
  return enArchivo
    ? ''
    : ` Ojo: tienes ${ENV_GO_KEY} en las variables de entorno de Windows; al reiniciar volvería a mandar esa: bórrala de ahí.`;
}

export type AplicarClaveResult = { ok: boolean; mensaje: string };

const GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';

export async function aplicarClaveGo(
  clave: string,
  deps: AplicarClaveDeps = {},
): Promise<AplicarClaveResult> {
  const limpia = clave.trim();
  if (limpia.length < 10 || /\s/.test(limpia)) {
    return {
      ok: false,
      mensaje:
        'Esa clave no tiene buena pinta (corta o con espacios). Cópiala entera de tu cuenta de OpenCode (apartado Go) y prueba otra vez.',
    };
  }
  const fetchFn = deps.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(GO_MODELS_URL, {
      headers: { Authorization: `Bearer ${limpia}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return {
      ok: false,
      mensaje:
        'No puedo comprobar la clave ahora mismo (sin conexión o Go no responde). No la he guardado: prueba en un momento.',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      mensaje:
        'OpenCode Go dice que esa clave no vale. Cópiala de nuevo de tu cuenta (opencode.ai, apartado Go). No la he guardado.',
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      mensaje: `Go responde raro ahora mismo (${res.status}). No la he guardado: prueba en un momento.`,
    };
  }
  const setKey = deps.setKey;
  if (!setKey) {
    return { ok: false, mensaje: 'El almacén de claves no está disponible ahora mismo.' };
  }
  await setKey('provider:apiKey', limpia);
  const nota = retirarClaveEnv(deps);
  return {
    ok: true,
    mensaje: `Clave guardada y comprobada con OpenCode Go. Las conversaciones nuevas ya la usan; si alguna abierta sigue fallando, escribe cualquier cosa de nuevo.${nota}`,
  };
}

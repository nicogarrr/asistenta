/**
 * Selector de modelo de la tarjeta Estado del panel local. Solo opciones de
 * coste cero VERIFICADO: medición del 2-nov-2026 contra /zen/go/v1 (la
 * suscripción OpenCode Go de Nico) con usage.cost = 0 y una llamada de
 * herramienta correcta en cada modelo de la lista. kimi-k3 quedó fuera: en la
 * prueba no llamó la herramienta. La suscripción Go no factura al llegar al
 * límite: bloquea (Extra usage OFF, balance 0 $), así que el coste se mantiene
 * en cero aunque se abuse.
 *
 * Todas las opciones son del proveedor OpenCode Go: al elegir, el panel fija
 * PA_PROVIDER_PRESET=opencode y PA_MODEL=<id> en el .env (persiste) y aplica
 * la config recargada al proceso vivo (las conversaciones nuevas ya la usan).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { envFileText } from './env-text.js';
import { dotEnvFiles } from './envfile.js';

export interface ModeloPanelOpcion {
  id: string;
  nombre: string;
  nota: string;
}

export const MODELOS_PANEL: ModeloPanelOpcion[] = [
  {
    id: 'deepseek-v4.1-flash',
    nombre: 'DeepSeek V4.1 Flash',
    nota: 'el de siempre: rápido y capaz',
  },
  { id: 'deepseek-v4-pro', nombre: 'DeepSeek V4 Pro', nota: 'más potente, más lento' },
  { id: 'glm-5.3-flash', nombre: 'GLM 5.3 Flash', nota: 'alternativa rápida' },
  { id: 'glm-5.3', nombre: 'GLM 5.3', nota: 'alternativa potente' },
  { id: 'qwen3.8-flash', nombre: 'Qwen 3.8 Flash', nota: 'otra opción rápida' },
  { id: 'minimax-m3.1-flash', nombre: 'MiniMax M3.1 Flash', nota: 'otra opción rápida' },
];

/**
 * Sustituye la línea activa `CLAVE=...` (si existe) o la añade al final. Las
 * líneas comentadas se respetan: se añade una activa nueva sin tocarlas.
 */
export function upsertEnvLines(texto: string, pares: Record<string, string>): string {
  let out = texto;
  for (const [clave, valor] of Object.entries(pares)) {
    const activa = new RegExp(`^[ \\t]*${clave}[ \\t]*=.*$`, 'm');
    if (activa.test(out)) {
      out = out.replace(activa, `${clave}=${valor}`);
    } else {
      if (out.length > 0 && !out.endsWith('\n')) out += '\n';
      out += `${clave}=${valor}\n`;
    }
  }
  return out;
}

export interface AplicarModeloDeps {
  readFile?: (path: string) => Buffer;
  writeFile?: (path: string, text: string) => void;
  env?: { PA_PROVIDER_PRESET?: string | undefined; PA_MODEL?: string | undefined };
  files?: string[];
  /** resetConfigForTests() + loadConfig(): la config derivada del entorno ya fijado. */
  reloadConfig?: () => Record<string, unknown>;
  /** Vuelca la config recargada sobre el objeto Config vivo del proceso. */
  applyConfig?: (fresh: Record<string, unknown>) => void;
}

export type AplicarModeloResult =
  | { ok: true; mensaje: string; modelo: string }
  | { ok: false; mensaje: string };

export function aplicarModeloPanel(
  id: string,
  deps: AplicarModeloDeps = {},
): AplicarModeloResult {
  const opcion = MODELOS_PANEL.find((m) => m.id === id);
  if (!opcion) {
    return {
      ok: false,
      mensaje: 'Ese modelo no está en la lista: solo ofrezco opciones de coste cero verificadas.',
    };
  }
  const env = deps.env ?? process.env;
  const read = deps.readFile ?? ((p: string) => readFileSync(p));
  const write = deps.writeFile ?? ((p: string, t: string) => writeFileSync(p, t, 'utf8'));
  const files = deps.files ?? dotEnvFiles();
  const pares = { PA_PROVIDER_PRESET: 'opencode', PA_MODEL: opcion.id };
  // El primer .env que existe; si no hay ninguno, se crea el primero.
  let destino = files[0] ?? '.env';
  for (const file of files) {
    try {
      read(file);
      destino = file;
      break;
    } catch {
      // no existe o no se puede leer: se prueba el siguiente
    }
  }
  let texto = '';
  try {
    // UTF-16/BOM entran por envFileText; al reescribir se guarda en UTF-8.
    texto = envFileText(read(destino));
  } catch {
    texto = '';
  }
  try {
    write(destino, upsertEnvLines(texto, pares));
  } catch {
    return {
      ok: false,
      mensaje: `No pude escribir el .env. Pon a mano: PA_PROVIDER_PRESET=opencode y PA_MODEL=${opcion.id}.`,
    };
  }
  env.PA_PROVIDER_PRESET = 'opencode';
  env.PA_MODEL = opcion.id;
  if (deps.reloadConfig && deps.applyConfig) deps.applyConfig(deps.reloadConfig());
  return {
    ok: true,
    modelo: opcion.id,
    mensaje: `Listo: Asistenta usa ${opcion.nombre} por OpenCode Go (coste 0). Las conversaciones nuevas ya van con él y queda guardado para los próximos arranques.`,
  };
}

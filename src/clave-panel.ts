/**
 * Campo «Clave de OpenCode Go» de la tarjeta Estado del panel: guarda la clave
 * en el almacén (provider:apiKey) SIN terminal. La comprueba en vivo contra Go
 * antes de guardarla: un typo se detecta al momento y no deja a Asistenta
 * sin modelo (2-nov-2026: una clave vieja en el almacén dejó a Nico bloqueado
 * tras pasar a opencode-go y la única vía era `pa vault set-stdin`).
 * La clave nunca se escribe en logs ni se devuelve al panel.
 */
export interface AplicarClaveDeps {
  setKey?: (key: string, value: string) => Promise<void>;
  fetchFn?: typeof fetch;
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
      mensaje: 'Esa clave no tiene buena pinta (corta o con espacios). Cópiala entera de tu cuenta de OpenCode (apartado Go) y prueba otra vez.',
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
      mensaje: 'No puedo comprobar la clave ahora mismo (sin conexión o Go no responde). No la he guardado: prueba en un momento.',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      mensaje: 'OpenCode Go dice que esa clave no vale. Cópiala de nuevo de tu cuenta (opencode.ai, apartado Go). No la he guardado.',
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
  return {
    ok: true,
    mensaje: 'Clave guardada y comprobada con OpenCode Go. Las conversaciones nuevas ya la usan; si alguna abierta sigue fallando, escribe cualquier cosa de nuevo.',
  };
}

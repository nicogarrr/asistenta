/**
 * Lee la dirección iCal (privada) del calendario con un tope de tiempo y de tamaño.
 *
 * Antes había cuatro copias en cli.ts y la de la herramienta «calendario» del chat
 * no tenía tope de tiempo: un servidor de calendario que aceptaba la conexión y no
 * contestaba dejaba la respuesta de Asistenta colgada sin decir nada. Tampoco había
 * tope de tamaño: un enlace equivocado a un fichero enorme se leía entero en memoria.
 * Los errores son frases cortas en castellano; agenda/ics.ts las convierte en el
 * aviso de siempre («No se ha podido leer el calendario: …»).
 */

export const ICS_FETCH_TIMEOUT_MS = 15_000;
/** Un calendario de años de eventos ronda 1–3 MB; 10 MB deja margen de sobra. */
export const ICS_MAX_BYTES = 10 * 1024 * 1024;

type FetchLike = (
  url: string,
  init: { redirect: 'follow'; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export interface IcsFetchOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function fetchIcsText(url: string, opts: IcsFetchOptions = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? ICS_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? ICS_MAX_BYTES;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  timer.unref?.();
  const seconds = Math.round(timeoutMs / 1000);
  const tooSlow = () => new Error(`el calendario no ha respondido en ${seconds} segundos`);
  // El temporizador corta también una lectura del cuerpo que se queda a medias,
  // aunque el fetch falso (o real) no escuche la señal.
  const deadline = new Promise<never>((_, reject) => {
    ctrl.signal.addEventListener('abort', () => reject(tooSlow()), { once: true });
  });
  deadline.catch(() => {});
  try {
    const read = async (): Promise<string> => {
      const res = await fetchImpl(url, { redirect: 'follow', signal: ctrl.signal });
      if (!res.ok) throw new Error(`el calendario ha respondido ${res.status}`);
      if (!res.body) {
        const text = await res.text();
        if (Buffer.byteLength(text) > maxBytes) throw tooBig(maxBytes);
        return text;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => {});
          throw tooBig(maxBytes);
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    };
    return await Promise.race([read(), deadline]);
  } catch (err) {
    if (timedOut) throw tooSlow();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function tooBig(maxBytes: number): Error {
  return new Error(
    `el calendario pesa más de ${Math.round(maxBytes / (1024 * 1024))} MB; revisa la dirección iCal`,
  );
}

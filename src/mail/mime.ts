/**
 * Texto legible del cuerpo de un correo a partir de su fuente RFC 5322.
 *
 * El cuerpo crudo no es texto: un correo normal en español llega como
 * `multipart/alternative` con la parte de texto en quoted-printable
 * (`qu=C3=A9`) y la HTML en base64. Antes se entregaba eso tal cual al agente,
 * con fronteras MIME, cabeceras de cada parte y base64 incluidos. Aquí se
 * recorre la estructura, se decodifica la transferencia y el charset, y se
 * prefiere `text/plain` sobre `text/html`. Los adjuntos no se leen.
 *
 * Sin dependencias y tolerante: la fuente puede venir truncada (maxLength) y
 * cualquier parte rara se salta en vez de lanzar.
 */

const MAX_DEPTH = 8;

interface Part {
  type: string;
  params: Map<string, string>;
  encoding: string;
  disposition: string;
  body: string; // bytes como latin1, 1:1
}

function splitHeaders(raw: string): {
  headers: Map<string, string>;
  body: string;
  hasHeaders: boolean;
} {
  const at = raw.search(/\r?\n\r?\n/);
  const headers = new Map<string, string>();
  if (at < 0) return { headers, body: raw, hasHeaders: false };
  const head = raw.slice(0, at).replace(/\r?\n[ \t]+/g, ' ');
  const body = raw.slice(at).replace(/^\r?\n\r?\n/, '');
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(i + 1).trim());
  }
  return { headers, body, hasHeaders: true };
}

function parseParams(value: string): { main: string; params: Map<string, string> } {
  const [main = '', ...rest] = value.split(';');
  const params = new Map<string, string>();
  for (const item of rest) {
    const eq = item.indexOf('=');
    if (eq < 0) continue;
    const key = item.slice(0, eq).trim().toLowerCase();
    let val = item.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    params.set(key, val);
  }
  return { main: main.trim().toLowerCase(), params };
}

function toPart(raw: string, defaultType: string): Part {
  const { headers, body } = splitHeaders(raw);
  const ct = parseParams(headers.get('content-type') ?? defaultType);
  return {
    type: ct.main || defaultType,
    params: ct.params,
    encoding: (headers.get('content-transfer-encoding') ?? '7bit').trim().toLowerCase(),
    disposition: parseParams(headers.get('content-disposition') ?? '').main,
    body,
  };
}

function decodeTransfer(body: string, encoding: string): Buffer {
  if (encoding === 'base64') {
    return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (encoding === 'quoted-printable') {
    const unfolded = body.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < unfolded.length; i++) {
      const ch = unfolded.charCodeAt(i);
      if (ch === 0x3d && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(unfolded.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(ch & 0xff);
      }
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(body, 'latin1');
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase();
  try {
    return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'utf-8' : label).decode(
      bytes,
    );
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** HTML a texto: fuera estilos, scripts y etiquetas; entidades en una sola pasada. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      const lower = name.toLowerCase();
      if (lower.startsWith('#x')) return safeCodePoint(Number.parseInt(lower.slice(2), 16), whole);
      if (lower.startsWith('#')) return safeCodePoint(Number.parseInt(lower.slice(1), 10), whole);
      return ENTITIES[lower] ?? whole;
    });
}

function safeCodePoint(n: number, fallback: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

function partText(part: Part, depth: number): { text: string; html: boolean } | null {
  if (depth > MAX_DEPTH) return null;
  if (part.disposition === 'attachment') return null;
  if (part.type.startsWith('multipart/')) {
    const boundary = part.params.get('boundary');
    if (!boundary) return null;
    const children = splitMultipart(part.body, boundary).map((raw) =>
      toPart(raw, part.type === 'multipart/digest' ? 'message/rfc822' : 'text/plain'),
    );
    if (part.type === 'multipart/alternative') {
      const plain = children.find((c) => c.type === 'text/plain');
      const pick = plain ?? children.find((c) => c.type === 'text/html') ?? children[0];
      return pick ? partText(pick, depth + 1) : null;
    }
    const texts = children
      .map((c) => partText(c, depth + 1))
      .filter((t): t is { text: string; html: boolean } => t !== null && t.text.trim() !== '');
    if (!texts.length) return null;
    return {
      text: texts.map((t) => (t.html ? htmlToText(t.text) : t.text)).join('\n\n'),
      html: false,
    };
  }
  if (part.type === 'message/rfc822') {
    const inner = decodeTransfer(part.body, part.encoding).toString('latin1');
    return partText(toPart(inner, 'text/plain'), depth + 1);
  }
  if (part.type === 'text/plain' || part.type === 'text/html') {
    const text = decodeCharset(
      decodeTransfer(part.body, part.encoding),
      part.params.get('charset'),
    );
    return { text, html: part.type === 'text/html' };
  }
  return null;
}

function splitMultipart(body: string, boundary: string): string[] {
  const lines = body.split(/\r?\n/);
  const open = `--${boundary}`;
  const close = `--${boundary}--`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === close) {
      if (current) parts.push(current.join('\r\n'));
      current = null;
      break;
    }
    if (trimmed === open) {
      if (current) parts.push(current.join('\r\n'));
      current = [];
      continue;
    }
    current?.push(line);
  }
  // Fuente truncada: la última parte abierta también cuenta.
  if (current?.length) parts.push(current.join('\r\n'));
  return parts;
}

/**
 * Texto del cuerpo listo para el agente. Una fuente sin cabeceras MIME se trata
 * como antes (texto tal cual, con HTML quitado), para no romper fuentes mínimas.
 */
export function extractBodyText(source: Buffer | string): string {
  const raw =
    typeof source === 'string'
      ? Buffer.from(source, 'utf8').toString('latin1')
      : source.toString('latin1');
  const { headers, hasHeaders } = splitHeaders(raw);
  if (!hasHeaders) return htmlToText(decodeCharset(Buffer.from(raw, 'latin1'), 'utf-8'));
  const part = toPart(raw, 'text/plain');
  const declared = headers.has('content-type');
  const found = partText(part, 0);
  if (!found) return '';
  // Sin Content-Type no hay forma de saber si es HTML: se quita marcado como antes.
  return found.html || !declared ? htmlToText(found.text) : found.text;
}

/**
 * La pantalla del iPhone como texto con posiciones, para que el modelo lea líneas en vez
 * de mirar una captura (una imagen son ~1.300 tokens; la misma pantalla en texto, unos
 * cientos) y pueda tocar «por texto» con la posición exacta.
 *
 * Idea tomada de phoneuse (github.com/lxe/phoneuse, MIT, © 2026 Aleksey Smolenchuk):
 * textualizar el espejo de AirPlay fuera del modelo, quitar la barra de estado, marcar la
 * flecha de volver, no escribir con el teléfono bloqueado y no tocar nunca la isla
 * dinámica. El código es nuestro (reescrito en TypeScript, en castellano); no se ha
 * copiado nada. Ver THIRD_PARTY_NOTICES.md.
 *
 * Todo aquí es puro: recibe el resultado del OCR (src/screen/ocr.ts, el de Windows) y
 * devuelve líneas en FRACCIONES de la pantalla (0..1, origen arriba a la izquierda), el
 * mismo espacio que usa el servidor de la ESP32 para tocar (/api/tap).
 */
import type { OcrResult } from '../screen/ocr.js';

export interface LineaPantalla {
  texto: string;
  /** Centro de la línea, en fracción del ancho (0..1). */
  x: number;
  /** Centro de la línea, en fracción del alto (0..1). */
  y: number;
}

/** Por encima de esta altura está la barra de estado (hora, cobertura, batería). */
export const BARRA_ESTADO = 0.055;
/** Cómo lee el OCR la flecha «‹» de volver arriba a la izquierda. */
const FLECHAS_VOLVER = new Set(['<', '‹', '〈', 'く', '«']);
/** Dos líneas a menos de esto en vertical van en la misma fila. */
const FILA = 0.012;

const redondea = (n: number) => Math.round(n * 1000) / 1000;

/**
 * El OCR, ordenado por filas y en fracciones. Sin `todo`, quita la barra de estado y los
 * «textos» sin letra ni número (iconos que el OCR confunde con letras). La flecha de
 * volver se queda como «[atrás]».
 */
export function lineasDePantalla(ocr: OcrResult, opts: { todo?: boolean } = {}): LineaPantalla[] {
  const w = ocr.width > 0 ? ocr.width : 1;
  const h = ocr.height > 0 ? ocr.height : 1;
  const out: LineaPantalla[] = [];
  for (const l of ocr.lines) {
    const bruto = l.text.replace(/\s+/g, ' ').trim();
    if (!bruto) continue;
    const x = (l.x + l.width / 2) / w;
    const y = (l.y + l.height / 2) / h;
    if (FLECHAS_VOLVER.has(bruto) && x < 0.15 && y < 0.2) {
      out.push({ texto: '[atrás]', x: redondea(x), y: redondea(y) });
      continue;
    }
    if (!opts.todo && (y < BARRA_ESTADO || !/[\p{L}\p{N}]/u.test(bruto))) continue;
    out.push({ texto: bruto, x: redondea(x), y: redondea(y) });
  }
  return out.sort((a, b) => Math.round(a.y / FILA) - Math.round(b.y / FILA) || a.x - b.x);
}

/** Tope de líneas que se devuelven: una pantalla muy densa no se come el turno. */
export const MAX_LINEAS = 150;

/** Las líneas como «x y  texto», una por fila, con la explicación de las coordenadas. */
export function formatearPantalla(lineas: LineaPantalla[], max = MAX_LINEAS): string {
  if (lineas.length === 0) {
    return 'No sale texto en la pantalla del iPhone (puede ser una foto, un vídeo, una pantalla solo de iconos o que aún esté cargando). Pide action=screenshot si hace falta verla.';
  }
  const vistas = lineas.slice(0, max);
  const filas = vistas.map((l) => `${l.x.toFixed(3)} ${l.y.toFixed(3)}  ${l.texto}`);
  const cabecera =
    `Pantalla del iPhone en texto (${lineas.length} líneas). Cada línea: x y (centro, en fracciones de la pantalla, 0 a 1) y el texto. ` +
    'Esas x y valen tal cual para tocar. Los iconos sin texto no salen: para eso, action=screenshot.';
  const resto =
    lineas.length > vistas.length
      ? `\nATENCIÓN: ${lineas.length - vistas.length} líneas más no se muestran; lo que buscas puede estar entre ellas.`
      : '';
  return `${cabecera}\n${filas.join('\n')}${resto}`;
}

const normaliza = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/["«»“”'’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * ¿Pantalla de bloqueo o de código? Con el teléfono bloqueado, lo que se escriba va al
 * campo del código y un código mal enviado cuenta como intento fallido: Asistenta no
 * escribe ni toca nada ahí. Solo Nico desbloquea.
 */
export function pantallaBloqueada(lineas: LineaPantalla[]): boolean {
  const todo = normaliza(lineas.map((l) => l.texto).join(' '));
  if (
    /\b(introduce|introducir|introduzca) (el )?codigo\b|\bpasscode\b|\bcodigo de acceso\b/.test(
      todo,
    )
  )
    return true;
  if (/\bemergencia\b/.test(todo) && /\bcancelar\b/.test(todo)) return true;
  if (/\bemergency\b/.test(todo) && /\bcancel\b/.test(todo)) return true;
  const reloj = lineas.filter(
    (l) =>
      /^\d{1,2}:\d{2}$/.test(l.texto.trim()) && l.y > 0.08 && l.y < 0.35 && l.x > 0.3 && l.x < 0.7,
  );
  const fecha = lineas.filter(
    (l) =>
      l.y < 0.25 &&
      /^(lunes|martes|miercoles|jueves|viernes|sabado|domingo|mon|tue|wed|thu|fri|sat|sun)/.test(
        normaliza(l.texto),
      ),
  );
  if (!reloj.length || !fecha.length) return false;
  // En la pantalla de bloqueo la fecha va encima del reloj grande.
  return Math.min(...fecha.map((l) => l.y)) < Math.max(...reloj.map((l) => l.y));
}

/** Palabras de relleno que el modelo añade al describir un elemento («botón Wi-Fi»). */
const RELLENO = new Set([
  'boton',
  'el',
  'la',
  'los',
  'las',
  'fila',
  'enlace',
  'opcion',
  'pestana',
  'celda',
  'button',
  'row',
  'link',
  'tab',
  'the',
]);

/** Parecido entre dos textos, de 0 a 1 (1 - distancia de edición / longitud mayor). */
export function parecido(a: string, b: string): number {
  if (a === b) return 1;
  const n = a.length;
  const m = b.length;
  if (!n || !m) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - (prev[m] ?? 0) / Math.max(n, m);
}

export type Busqueda =
  | { ok: true; linea: LineaPantalla; como: 'exacto' | 'empieza' | 'parecido' }
  | { ok: false; motivo: 'vacio' | 'no-esta' | 'ambiguo'; candidatas: LineaPantalla[] };

/**
 * Busca un texto en la pantalla para tocarlo. Exacto primero; si no, la ÚNICA línea que
 * empiece por él; si no, la única muy parecida (el OCR a veces lee mal una letra). Nunca
 * adivina: con dos candidatas o ninguna, no hay toque. Un modelo de «grounding» siempre
 * responde aunque el elemento no esté; esto, no.
 */
export function buscarTexto(lineas: LineaPantalla[], que: string): Busqueda {
  const palabras = normaliza(que)
    .split(' ')
    .filter((p) => p && !RELLENO.has(p));
  if (!palabras.length) return { ok: false, motivo: 'vacio', candidatas: [] };
  const buscado = palabras.join(' ');
  const en = lineas
    .filter((l) => l.y >= BARRA_ESTADO && l.texto !== '[atrás]')
    .map((l) => ({ l, t: normaliza(l.texto) }));
  const exactas = en.filter((e) => e.t === buscado);
  if (exactas.length === 1 && exactas[0]) return { ok: true, linea: exactas[0].l, como: 'exacto' };
  if (exactas.length > 1)
    return { ok: false, motivo: 'ambiguo', candidatas: exactas.map((e) => e.l) };
  const empiezan = en.filter((e) => e.t.startsWith(buscado));
  if (empiezan.length === 1 && empiezan[0])
    return { ok: true, linea: empiezan[0].l, como: 'empieza' };
  if (empiezan.length > 1)
    return { ok: false, motivo: 'ambiguo', candidatas: empiezan.map((e) => e.l) };
  const puntuadas = en
    .map((e) => ({ l: e.l, p: parecido(buscado, e.t) }))
    .sort((a, b) => b.p - a.p);
  const [mejor, segunda] = puntuadas;
  if (mejor && mejor.p >= 0.85 && (!segunda || segunda.p < mejor.p - 0.1)) {
    return { ok: true, linea: mejor.l, como: 'parecido' };
  }
  return { ok: false, motivo: 'no-esta', candidatas: [] };
}

/**
 * Zonas donde no se toca: la isla dinámica (arriba en el centro) abre el aviso de
 * «Detener duplicación», que corta la pantalla en directo; y fuera de 0..1 no hay nada.
 * Devuelve el motivo o null si se puede tocar.
 */
export function zonaProhibida(x: number, y: number): string | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    return 'x e y van en fracciones de la pantalla, de 0 a 1.';
  }
  if (y < 0.06 && x > 0.3 && x < 0.7) {
    return 'Ahí está la isla dinámica: tocarla abre «Detener duplicación» y se corta la pantalla. No toco ahí.';
  }
  return null;
}

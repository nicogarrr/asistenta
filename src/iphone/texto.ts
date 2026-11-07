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

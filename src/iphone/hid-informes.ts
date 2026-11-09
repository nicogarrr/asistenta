/**
 * Informes HID para manejar el iPhone por Bluetooth LE (HID sobre GATT) desde el propio PC,
 * sin la ESP32. Todo puro: aquí solo se construyen bytes y secuencias; el que los manda es
 * el ayudante de Windows (deploy/iphone/windows/AsistentaHid.cs).
 *
 * Ideas tomadas de phoneuse (github.com/lxe/phoneuse, MIT, © 2026 Aleksey Smolenchuk,
 * phoneuse/touch.py y hid_daemon.py), reescritas sin su código:
 * - un puntero ABSOLUTO aterriza donde se pide, sin calibrar, y en iOS solo él cuenta las
 *   pulsaciones;
 * - mover, esperar ~0,1 s y luego pulsar;
 * - arrastrar = pulsar en absoluto, mover en RELATIVO un informe cada 8 ms (iOS descarta
 *   los que llegan más seguidos) y soltar en absoluto.
 * Lo midieron por Bluetooth clásico en un iPhone 17 Pro con iOS 26. Por BLE (HOGP) NO está
 * comprobado que iOS trate igual el puntero absoluto.
 */

/** Identificadores de informe (uno por característica «Report» del servicio HID). */
export const INFORME_TECLADO = 1;
export const INFORME_RATON = 2;
export const INFORME_ABSOLUTO = 3;

/** Rango lógico del puntero absoluto: 0..32767 en cada eje. */
export const ABS_MAX = 32767;

/**
 * Mapa de informes (Report Map, característica 0x2A4B). Escrito a mano desde la
 * especificación HID 1.11 y las tablas de uso: teclado de arranque (id 1), ratón relativo
 * con rueda (id 2) y puntero absoluto de 3 botones con X/Y de 16 bits (id 3).
 */
// biome-ignore format: tabla HID, un elemento por línea con su comentario
export const MAPA_INFORMES: readonly number[] = [
  // --- id 1: teclado (modificadores, reservado, 6 teclas) ---
  0x05, 0x01, // Usage Page (Generic Desktop)
  0x09, 0x06, // Usage (Keyboard)
  0xa1, 0x01, // Collection (Application)
  0x85, INFORME_TECLADO, //   Report ID (1)
  0x05, 0x07, //   Usage Page (Keyboard/Keypad)
  0x19, 0xe0, //   Usage Minimum (Left Control)
  0x29, 0xe7, //   Usage Maximum (Right GUI)
  0x15, 0x00, //   Logical Minimum (0)
  0x25, 0x01, //   Logical Maximum (1)
  0x75, 0x01, //   Report Size (1)
  0x95, 0x08, //   Report Count (8)
  0x81, 0x02, //   Input (Data, Variable, Absolute): modificadores
  0x95, 0x01, //   Report Count (1)
  0x75, 0x08, //   Report Size (8)
  0x81, 0x01, //   Input (Constant): reservado
  0x95, 0x06, //   Report Count (6)
  0x75, 0x08, //   Report Size (8)
  0x15, 0x00, //   Logical Minimum (0)
  0x25, 0x65, //   Logical Maximum (101)
  0x05, 0x07, //   Usage Page (Keyboard/Keypad)
  0x19, 0x00, //   Usage Minimum (0)
  0x29, 0x65, //   Usage Maximum (101)
  0x81, 0x00, //   Input (Data, Array): teclas
  0xc0, // End Collection
  // --- id 2: ratón relativo (botones, x, y, rueda) ---
  0x05, 0x01, // Usage Page (Generic Desktop)
  0x09, 0x02, // Usage (Mouse)
  0xa1, 0x01, // Collection (Application)
  0x85, INFORME_RATON, //   Report ID (2)
  0x09, 0x01, //   Usage (Pointer)
  0xa1, 0x00, //   Collection (Physical)
  0x05, 0x09, //     Usage Page (Button)
  0x19, 0x01, //     Usage Minimum (1)
  0x29, 0x03, //     Usage Maximum (3)
  0x15, 0x00, //     Logical Minimum (0)
  0x25, 0x01, //     Logical Maximum (1)
  0x95, 0x03, //     Report Count (3)
  0x75, 0x01, //     Report Size (1)
  0x81, 0x02, //     Input (Data, Variable, Absolute)
  0x95, 0x01, //     Report Count (1)
  0x75, 0x05, //     Report Size (5)
  0x81, 0x01, //     Input (Constant): relleno
  0x05, 0x01, //     Usage Page (Generic Desktop)
  0x09, 0x30, //     Usage (X)
  0x09, 0x31, //     Usage (Y)
  0x09, 0x38, //     Usage (Wheel)
  0x15, 0x81, //     Logical Minimum (-127)
  0x25, 0x7f, //     Logical Maximum (127)
  0x75, 0x08, //     Report Size (8)
  0x95, 0x03, //     Report Count (3)
  0x81, 0x06, //     Input (Data, Variable, Relative)
  0xc0, //   End Collection
  0xc0, // End Collection
  // --- id 3: puntero absoluto (botones, X 0..32767, Y 0..32767) ---
  0x05, 0x01, // Usage Page (Generic Desktop)
  0x09, 0x02, // Usage (Mouse)
  0xa1, 0x01, // Collection (Application)
  0x85, INFORME_ABSOLUTO, //   Report ID (3)
  0x09, 0x01, //   Usage (Pointer)
  0xa1, 0x00, //   Collection (Physical)
  0x05, 0x09, //     Usage Page (Button)
  0x19, 0x01, //     Usage Minimum (1)
  0x29, 0x03, //     Usage Maximum (3)
  0x15, 0x00, //     Logical Minimum (0)
  0x25, 0x01, //     Logical Maximum (1)
  0x95, 0x03, //     Report Count (3)
  0x75, 0x01, //     Report Size (1)
  0x81, 0x02, //     Input (Data, Variable, Absolute)
  0x95, 0x01, //     Report Count (1)
  0x75, 0x05, //     Report Size (5)
  0x81, 0x01, //     Input (Constant): relleno
  0x05, 0x01, //     Usage Page (Generic Desktop)
  0x09, 0x30, //     Usage (X)
  0x09, 0x31, //     Usage (Y)
  0x15, 0x00, //     Logical Minimum (0)
  0x26, ABS_MAX & 0xff, ABS_MAX >> 8, //     Logical Maximum (32767)
  0x75, 0x10, //     Report Size (16)
  0x95, 0x02, //     Report Count (2)
  0x81, 0x02, //     Input (Data, Variable, Absolute)
  0xc0, //   End Collection
  0xc0, // End Collection
];

/** Un informe que mandar y lo que se espera DESPUÉS de mandarlo, en ms. */
export interface PasoHid {
  r: number;
  d: number[];
  ms: number;
}

const fraccion = (v: number) => Math.min(Math.max(Number.isFinite(v) ? v : 0, 0), 1);
const int8 = (v: number) => (Math.max(-127, Math.min(127, Math.trunc(v))) + 256) % 256;

/** Puntero absoluto en (x, y) en fracciones de la pantalla, con el botón pulsado o no. */
export function absoluto(x: number, y: number, pulsado: boolean, ms: number): PasoHid {
  const ax = Math.round(fraccion(x) * ABS_MAX);
  const ay = Math.round(fraccion(y) * ABS_MAX);
  return { r: INFORME_ABSOLUTO, d: [pulsado ? 1 : 0, ax & 0xff, ax >> 8, ay & 0xff, ay >> 8], ms };
}

/** Movimiento relativo del ratón, sin botón (iOS arrastra así el toque que empezó en absoluto). */
export function relativo(dx: number, dy: number, ms: number): PasoHid {
  return { r: INFORME_RATON, d: [0, int8(dx), int8(dy), 0], ms };
}

/** Teclado: modificadores y hasta 6 teclas; sin teclas = todo suelto. */
export function teclado(mods: number, teclas: number[], ms: number): PasoHid {
  const k = [...teclas.slice(0, 6)];
  while (k.length < 6) k.push(0);
  return { r: INFORME_TECLADO, d: [mods & 0xff, 0, ...k], ms };
}

/** Todo suelto: teclado, ratón y puntero (parada de emergencia). */
export function soltarTodo(): PasoHid[] {
  return [teclado(0, [], 0), { r: INFORME_RATON, d: [0, 0, 0, 0], ms: 0 }];
}

/** Moverse, dar tiempo al puntero y luego pulsar (pulsar en el mismo instante falla). */
export const ANTES_DE_PULSAR_MS = 100;
/** Cuánto dura el dedo en un toque. */
export const TOQUE_MS = 60;
/** Un informe relativo cada 8 ms durante un arrastre. */
export const TICK_MS = 8;
/**
 * Tamaño de cada informe relativo al arrastrar y lo que mueve en puntos de pantalla.
 * Valor medido por phoneuse por Bluetooth clásico (2 unidades ≈ 6,9 pt cada 8 ms); por
 * BLE sin comprobar. Pequeño y constante a propósito: iOS acelera según el tamaño.
 */
export const UNIDADES_TICK = 2;
export const PUNTOS_POR_TICK = 6.9;

/** Tamaño de la pantalla del iPhone en puntos (iPhone 17 Pro: 402 x 874). */
export interface PuntosPantalla {
  ancho: number;
  alto: number;
}
export const PANTALLA_POR_DEFECTO: PuntosPantalla = { ancho: 402, alto: 874 };

/** `PA_IPHONE_PUNTOS=402x874`; si no es válido, el del iPhone 17 Pro. */
export function puntosDePantalla(valor: string | undefined): PuntosPantalla {
  const m = (valor ?? '').trim().match(/^(\d{3,4})\s*[xX×]\s*(\d{3,4})$/);
  if (!m) return PANTALLA_POR_DEFECTO;
  return { ancho: Number(m[1]), alto: Number(m[2]) };
}

/** Toque exacto: ir, esperar, pulsar, soltar. */
export function secuenciaToque(x: number, y: number): PasoHid[] {
  return [
    absoluto(x, y, false, ANTES_DE_PULSAR_MS),
    absoluto(x, y, true, TOQUE_MS),
    absoluto(x, y, false, 0),
  ];
}

/** Tope de informes de un arrastre (unas 2 pantallas a la velocidad fija). */
export const MAX_TICKS = 300;

/**
 * Arrastre pausado: pulsar en absoluto en el origen, ir en relativo un informe cada 8 ms
 * del mismo tamaño hacia el destino (repartiendo el redondeo para no torcerse) y soltar
 * en absoluto en el destino.
 */
export function secuenciaArrastre(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  pantalla: PuntosPantalla = PANTALLA_POR_DEFECTO,
): PasoHid[] {
  const [ax, ay, bx, by] = [fraccion(x1), fraccion(y1), fraccion(x2), fraccion(y2)];
  const px = (bx - ax) * pantalla.ancho;
  const py = (by - ay) * pantalla.alto;
  const dist = Math.hypot(px, py);
  const ticks = Math.min(Math.floor(dist / PUNTOS_POR_TICK), MAX_TICKS);
  const pasos: PasoHid[] = [
    absoluto(ax, ay, false, ANTES_DE_PULSAR_MS),
    absoluto(ax, ay, true, TICK_MS),
  ];
  if (ticks > 0) {
    const ux = (UNIDADES_TICK * px) / dist;
    const uy = (UNIDADES_TICK * py) / dist;
    let restoX = 0;
    let restoY = 0;
    for (let i = 0; i < ticks; i++) {
      restoX += ux;
      restoY += uy;
      const dx = Math.round(restoX);
      const dy = Math.round(restoY);
      restoX -= dx;
      restoY -= dy;
      pasos.push(relativo(dx, dy, TICK_MS));
    }
  }
  pasos.push(absoluto(bx, by, false, 0));
  return pasos;
}

/** Modificadores del teclado HID. */
export const MOD = { ctrl: 0x01, shift: 0x02, alt: 0x04, cmd: 0x08 } as const;

const NOMBRADAS: Record<string, number> = {
  enter: 0x28,
  esc: 0x29,
  backspace: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  right: 0x4f,
  left: 0x50,
  down: 0x51,
  up: 0x52,
};

/** Teclado de EE. UU.: carácter → [código, modificadores]. Solo ASCII imprimible. */
export function teclaDeCaracter(c: string): [number, number] | null {
  if (c.length !== 1) return null;
  if (c >= 'a' && c <= 'z') return [0x04 + c.charCodeAt(0) - 97, 0];
  if (c >= 'A' && c <= 'Z') return [0x04 + c.charCodeAt(0) - 65, MOD.shift];
  if (c >= '1' && c <= '9') return [0x1e + c.charCodeAt(0) - 49, 0];
  if (c === '0') return [0x27, 0];
  if (c === ' ') return [0x2c, 0];
  const conShift = '!@#$%^&*()';
  const i = conShift.indexOf(c);
  if (i >= 0) return [0x1e + i, MOD.shift];
  const signos: Record<string, [number, number]> = {
    '-': [0x2d, 0],
    _: [0x2d, MOD.shift],
    '=': [0x2e, 0],
    '+': [0x2e, MOD.shift],
    '[': [0x2f, 0],
    '{': [0x2f, MOD.shift],
    ']': [0x30, 0],
    '}': [0x30, MOD.shift],
    '\\': [0x31, 0],
    '|': [0x31, MOD.shift],
    ';': [0x33, 0],
    ':': [0x33, MOD.shift],
    "'": [0x34, 0],
    '"': [0x34, MOD.shift],
    '`': [0x35, 0],
    '~': [0x35, MOD.shift],
    ',': [0x36, 0],
    '<': [0x36, MOD.shift],
    '.': [0x37, 0],
    '>': [0x37, MOD.shift],
    '/': [0x38, 0],
    '?': [0x38, MOD.shift],
  };
  return signos[c] ?? null;
}

/** Pulsación y suelta de cada tecla. */
export const TECLA_MS = 12;

/** Escribir texto ASCII (los saltos de línea los hace quien llama, con Intro). */
export function secuenciaTexto(texto: string): PasoHid[] {
  const pasos: PasoHid[] = [];
  for (const c of texto) {
    const t = teclaDeCaracter(c);
    if (!t) throw new Error(`El teclado Bluetooth es de EE. UU. y no sabe escribir «${c}».`);
    pasos.push(teclado(t[1], [t[0]], TECLA_MS), teclado(0, [], TECLA_MS));
  }
  return pasos;
}

/** Combo validado antes (gestos.comboValido): «cmd+h», «shift+tab», «enter»… */
export function secuenciaCombo(combo: string): PasoHid[] {
  const partes = combo.trim().toLowerCase().split('+');
  const tecla = partes.pop() ?? '';
  let mods = 0;
  for (const p of partes) {
    const m = MOD[p as keyof typeof MOD];
    if (m === undefined) throw new Error(`Modificador desconocido: ${p}`);
    mods |= m;
  }
  const codigo = NOMBRADAS[tecla] ?? teclaDeCaracter(tecla)?.[0];
  if (codigo === undefined) throw new Error(`Tecla desconocida: ${tecla}`);
  return [teclado(mods, [], TECLA_MS), teclado(mods, [codigo], 40), teclado(0, [], TECLA_MS)];
}

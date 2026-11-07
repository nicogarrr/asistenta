/**
 * Temas de la memoria: `memoria/notas/<tema>.md`, un fichero por tema (salud,
 * trabajo, casa…), no uno por chat. Nico pidió «notas por tema» (13:53, 7 nov.).
 *
 * El tema se elige al escribir (`tema` en la herramienta memory). Si no viene,
 * lo pone este clasificador local por palabras clave: sin red, sin modelo, y
 * `general` cuando nada encaja. La pasada nocturna vuelve a mirar lo que quedó en
 * `general` por si ya encaja en otro tema.
 */

export const TEMA_GENERAL = 'general';

/** Temas conocidos y sus palabras (sin tildes, en minúscula; se acepta plural en -s/-es). */
export const TEMAS_CONOCIDOS: Readonly<Record<string, readonly string[]>> = {
  salud: [
    'salud',
    'medico',
    'medica',
    'doctor',
    'doctora',
    'hospital',
    'urgencias',
    'dolor',
    'alergia',
    'alergico',
    'alergica',
    'medicamento',
    'medicina',
    'pastilla',
    'dentista',
    'farmacia',
    'vacuna',
    'analisis',
    'fisio',
    'fisioterapeuta',
    'enfermo',
    'enferma',
    'gimnasio',
    'gym',
    'dieta',
    'peso',
    'kilos',
    'tension',
    'colesterol',
    'migrana',
    'receta',
    'operacion',
    'lesion',
    'psicologo',
    'psicologa',
    'ansiedad',
    'dormir',
  ],
  trabajo: [
    'trabajo',
    'curro',
    'oficina',
    'jefe',
    'jefa',
    'reunion',
    'cliente',
    'proyecto',
    'empresa',
    'nomina',
    'companero',
    'companera',
    'entrevista',
    'linkedin',
    'contrato',
    'teletrabajo',
    'vacaciones',
    'sueldo',
    'salario',
    'freelance',
    'deadline',
    'sprint',
  ],
  casa: [
    'casa',
    'piso',
    'alquiler',
    'casero',
    'casera',
    'hipoteca',
    'cocina',
    'lavadora',
    'lavavajillas',
    'nevera',
    'limpieza',
    'comunidad',
    'vecino',
    'vecina',
    'wifi',
    'router',
    'television',
    'tv',
    'salon',
    'habitacion',
    'mudanza',
    'fontanero',
    'electricista',
    'calefaccion',
    'aire acondicionado',
    'terraza',
    'jardin',
    'muebles',
    'ikea',
  ],
  coches: [
    'coche',
    'moto',
    'itv',
    'taller',
    'gasolina',
    'diesel',
    'matricula',
    'neumatico',
    'rueda',
    'aparcar',
    'parking',
    'conducir',
    'carnet de conducir',
    'multa',
    'dgt',
    'mecanico',
    'revision del coche',
    'seguro del coche',
    'tesla',
    'electrico',
    'cargador',
  ],
  finanzas: [
    'banco',
    'tarjeta',
    'dinero',
    'euros',
    'ahorro',
    'inversion',
    'invertir',
    'acciones',
    'bolsa',
    'impuestos',
    'hacienda',
    'renta',
    'irpf',
    'iva',
    'factura',
    'pago',
    'gasto',
    'presupuesto',
    'cripto',
    'bitcoin',
    'broker',
    'fondo indexado',
    'transferencia',
    'bizum',
    'prestamo',
    'deuda',
    'nomina',
    'paypal',
    'revolut',
    'etf',
  ],
  gerarai: ['gerarai', 'gerar ai', 'gerar'],
  amazon: ['amazon', 'aws', 'pedido de amazon'],
  musica: [
    'musica',
    'cancion',
    'spotify',
    'concierto',
    'disco',
    'album',
    'guitarra',
    'piano',
    'playlist',
    'cantante',
    'grupo de musica',
    'festival',
    'vinilo',
  ],
};

/** Sin tildes ni mayúsculas: «Médico» y «medico» son la misma palabra. */
export function plegarTexto(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PATRONES: ReadonlyArray<readonly [string, RegExp]> = Object.entries(TEMAS_CONOCIDOS).map(
  ([tema, palabras]) =>
    [
      tema,
      new RegExp(
        `(?<![a-z0-9])(?:${palabras.map(escaparRegex).join('|')})(?:s|es)?(?![a-z0-9])`,
        'g',
      ),
    ] as const,
);

/**
 * Nombre de tema seguro como nombre de fichero en Windows: minúsculas, sin
 * tildes, solo `a-z0-9-`. Null si no queda nada usable o es un nombre reservado
 * (el índice, ficheros internos con `_` o `.`).
 */
export function normalizarTema(tema: string | undefined | null): string | null {
  if (typeof tema !== 'string') return null;
  const limpio = plegarTexto(tema.trim())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (!limpio || limpio === 'indice') return null;
  // Nombres de dispositivo de Windows: «con.md» no se puede crear.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(limpio)) return null;
  return limpio;
}

/**
 * Tema de un hecho por palabras clave. Una etiqueta que ya es un tema conocido
 * manda; si no, gana el tema con más aciertos (empate: el primero de la lista).
 * `general` cuando nada encaja.
 */
export function clasificarTema(texto: string, tags: readonly string[] = []): string {
  for (const tag of tags) {
    const t = normalizarTema(tag);
    if (t && t in TEMAS_CONOCIDOS) return t;
  }
  const plano = plegarTexto(`${texto} ${tags.join(' ')}`);
  let mejor = TEMA_GENERAL;
  let max = 0;
  for (const [tema, re] of PATRONES) {
    const n = plano.match(re)?.length ?? 0;
    if (n > max) {
      max = n;
      mejor = tema;
    }
  }
  return mejor;
}

/** El valor de `chat:` en una línea de tema, sin romper el formato `(a, b: c)`. */
export function codificarChat(scope: string): string {
  return scope.replace(
    /[%,()\r\n]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

export function decodificarChat(valor: string): string {
  return valor.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) =>
    String.fromCharCode(Number.parseInt(h, 16)),
  );
}

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import {
  type Celda,
  columnasNumericas,
  leerNumero,
  nombreArchivo,
  type Tabla,
  textoCelda,
} from '../entregables/datos.js';
import { crearDocx } from '../entregables/docx.js';
import { dibujarGrafica, MAX_PUNTOS, type TipoGrafica } from '../entregables/grafica.js';
import { crearPdf } from '../entregables/pdf.js';
import { crearXlsx } from '../entregables/xlsx.js';
import { log } from '../log.js';

/**
 * «Hazme una gráfica de mis gastos», «pásamelo en Excel», «en PDF»: el modelo ya tiene los
 * datos (del correo, de un documento, de lo que le has contado) y esta herramienta los
 * convierte en un archivo de verdad y lo manda a este mismo chat: PNG, .xlsx o PDF.
 * Gratis y sin red: todo se genera en el PC (sin navegador ni librerías nativas). No lee
 * ni escribe ficheros del PC ni sale a internet: solo manda el archivo a esta conversación.
 */

export const MAX_FILAS = 5_000;
export const MAX_COLUMNAS = 40;

const Params = lazySchema(() =>
  Type.Object({
    formato: Type.Union(
      [Type.Literal('grafica'), Type.Literal('excel'), Type.Literal('pdf'), Type.Literal('word')],
      {
        description:
          'grafica = imagen PNG; excel = archivo .xlsx; pdf = documento PDF; word = documento .docx.',
      },
    ),
    titulo: Type.String({
      maxLength: 120,
      description: 'Título (y nombre del archivo), p. ej. «Gastos de octubre».',
    }),
    columnas: Type.Array(Type.String({ maxLength: 80 }), {
      maxItems: MAX_COLUMNAS,
      description:
        'Cabecera. Para una gráfica: la primera columna son las etiquetas (mes, categoría) y las siguientes, las series de números.',
    }),
    filas: Type.Array(
      Type.Array(Type.Union([Type.String({ maxLength: 500 }), Type.Number(), Type.Null()]), {
        maxItems: MAX_COLUMNAS,
      }),
      {
        maxItems: MAX_FILAS,
        description:
          'Las filas, en el orden de las columnas. Importes como número o como «12,50 €».',
      },
    ),
    tipo: Type.Optional(
      Type.Union([Type.Literal('barras'), Type.Literal('lineas'), Type.Literal('tarta')], {
        description:
          'Tipo de gráfica (por defecto barras; lineas para evolución en el tiempo; tarta para el reparto).',
      }),
    ),
    texto: Type.Optional(
      Type.String({
        maxLength: 20_000,
        description:
          'PDF y Word: texto o resumen que va antes de la tabla (en Word admite «# Encabezado», «- viñeta» y **negrita**).',
      }),
    ),
    con_grafica: Type.Optional(
      Type.Boolean({ description: 'Solo PDF: incluir también la gráfica de los datos.' }),
    ),
    totales: Type.Optional(
      Type.Boolean({
        description:
          'Excel, PDF y Word: añadir una fila «Total» con la suma de cada columna de números.',
      }),
    ),
  }),
);

export interface EntregableDeps {
  /** Manda la imagen a la conversación; `true` si salió. */
  sendPhoto: (png: Buffer) => Promise<boolean>;
  /** Manda el archivo a la conversación; `true` si salió. */
  sendDocument: (bytes: Buffer, filename: string, caption: string) => Promise<boolean>;
}

interface Args {
  formato: 'grafica' | 'excel' | 'pdf' | 'word';
  titulo: string;
  columnas: string[];
  filas: Celda[][];
  tipo?: TipoGrafica;
  texto?: string;
  con_grafica?: boolean;
  totales?: boolean;
}

/** La gráfica de una tabla: primera columna no numérica = etiquetas; columnas de números = series. */
export function graficaDeTabla(t: Tabla, titulo: string, tipo?: TipoGrafica): Buffer {
  const nums = columnasNumericas(t);
  const etiquetaCol = t.columnas.findIndex((_, c) => !nums.includes(c));
  const series = nums.filter((c) => c !== etiquetaCol);
  if (series.length === 0)
    throw new Error(
      'Para la gráfica necesito al menos una columna de números (importes, cantidades…).',
    );
  const filas = t.filas.filter((f) => series.some((c) => leerNumero(f[c] ?? null) !== null));
  if (filas.length === 0) throw new Error('No hay ninguna fila con números para la gráfica.');
  if (filas.length > MAX_PUNTOS)
    throw new Error(
      `Son ${filas.length} filas: demasiadas para una gráfica (máximo ${MAX_PUNTOS}). Agrúpalas por mes o por categoría.`,
    );
  return dibujarGrafica({
    titulo,
    tipo,
    etiquetas: filas.map((f, i) => (etiquetaCol >= 0 ? textoCelda(f[etiquetaCol]) : String(i + 1))),
    series: series.map((c) => ({
      nombre: t.columnas[c] ?? '',
      valores: filas.map((f) => leerNumero(f[c] ?? null) ?? 0),
    })),
  });
}

export function createEntregableTool(deps: EntregableDeps): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'entregable',
    label: 'Gráfica, Excel o PDF',
    description:
      'Crea y manda a este chat una gráfica (imagen), un Excel (.xlsx), un PDF o un Word (.docx) con los datos que le pases. Úsala para «hazme una gráfica de mis gastos», «pásamelo en Excel», «ponlo en PDF», «hazme un Word con…». Reúne antes los datos (correo, documentos, lo que te haya dicho) y pásalos como columnas y filas; no inventes datos. Para una gráfica, agrupa (por mes, por categoría) si hay muchas filas.',
    parameters: Params(),
    execute: async (_id, raw) => {
      const a = raw as Args;
      const responder = (text: string) => ({
        content: [{ type: 'text' as const, text }],
        details: {},
      });
      const tabla: Tabla = {
        columnas: a.columnas ?? [],
        filas: (a.filas ?? []).filter((f) => Array.isArray(f)),
      };
      // Un PDF o un Word pueden ser solo texto («pásame este resumen en Word»); gráfica y Excel no.
      if (
        tabla.columnas.length === 0 &&
        (a.formato === 'grafica' || a.formato === 'excel' || !a.texto?.trim())
      )
        return responder('Necesito al menos una columna con datos.');
      if (tabla.filas.length > MAX_FILAS)
        return responder(`Son demasiadas filas (máximo ${MAX_FILAS}).`);
      const titulo = (a.titulo ?? '').trim() || 'Datos';
      try {
        if (a.formato === 'grafica') {
          const png = graficaDeTabla(tabla, titulo, a.tipo);
          const ok = await deps.sendPhoto(png);
          return responder(
            ok ? `Gráfica «${titulo}» enviada al chat.` : 'No he podido mandar la gráfica al chat.',
          );
        }
        if (a.formato === 'excel') {
          const bytes = crearXlsx({ ...tabla, hoja: titulo, totales: a.totales });
          const nombre = nombreArchivo(titulo, 'xlsx');
          const ok = await deps.sendDocument(bytes, nombre, titulo);
          return responder(
            ok
              ? `Excel «${nombre}» enviado al chat (${tabla.filas.length} filas).`
              : `No he podido mandar «${nombre}» al chat.`,
          );
        }
        if (a.formato === 'word') {
          const bytes = crearDocx({ ...tabla, titulo, texto: a.texto, totales: a.totales });
          const nombre = nombreArchivo(titulo, 'docx');
          const ok = await deps.sendDocument(bytes, nombre, titulo);
          return responder(
            ok ? `Word «${nombre}» enviado al chat.` : `No he podido mandar «${nombre}» al chat.`,
          );
        }
        let imagen: Buffer | undefined;
        let aviso = '';
        if (a.con_grafica) {
          try {
            imagen = graficaDeTabla(tabla, titulo, a.tipo);
          } catch (err) {
            aviso = ` Sin gráfica: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        const bytes = await crearPdf({
          ...tabla,
          titulo,
          texto: a.texto,
          imagen,
          totales: a.totales,
        });
        const nombre = nombreArchivo(titulo, 'pdf');
        const ok = await deps.sendDocument(bytes, nombre, titulo);
        return responder(
          ok
            ? `PDF «${nombre}» enviado al chat.${aviso}`
            : `No he podido mandar «${nombre}» al chat.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('entregable: no se pudo crear', { formato: a.formato, err: msg });
        return responder(msg);
      }
    },
  };
}

/**
 * Funciones puras del panel web que se ejecutan EN EL NAVEGADOR.
 *
 * page.ts las incrusta en el <script> con `Function.prototype.toString`, así
 * que no pueden cerrar sobre imports ni sobre otras variables del módulo:
 * todo lo que usan va dentro de cada función. Viven aquí para poder probarlas
 * con vitest sin DOM.
 */

/** Lo que la tarjeta de una aprobación necesita para ser legible. */
export interface ResumenAprobacion {
  /** La pregunta en lenguaje humano; el nombre de la herramienta solo si no hay otra cosa. */
  titulo: string;
  motivo: string;
  herramienta: string;
  /** Epoch ms de caducidad, o null si no viene. */
  caduca: number | null;
}

export function resumenAprobacion(item: unknown, indice: number): ResumenAprobacion {
  const texto = (valor: unknown): string =>
    typeof valor === 'string' || typeof valor === 'number' ? String(valor).trim() : '';
  if (typeof item === 'string') {
    return { titulo: item, motivo: '', herramienta: '', caduca: null };
  }
  const registro =
    item && typeof item === 'object'
      ? (item as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const herramienta = texto(registro.tool) || texto(registro.toolName);
  const motivo = texto(registro.reason);
  let titulo = '';
  const claves = ['question', 'title', 'label', 'summary', 'description', 'action'];
  for (const clave of claves) {
    titulo = texto(registro[clave]);
    if (titulo) break;
  }
  if (!titulo) titulo = motivo || herramienta || `Aprobación ${indice + 1}`;
  const bruto = registro.expiresAt;
  let caduca: number | null = null;
  if (typeof bruto === 'number' && Number.isFinite(bruto)) caduca = bruto;
  else if (typeof bruto === 'string' && bruto.trim() !== '') {
    const ms = Date.parse(bruto);
    if (Number.isFinite(ms)) caduca = ms;
  }
  return { titulo, motivo: motivo === titulo ? '' : motivo, herramienta, caduca };
}

/** «Caduca en 4 min 20 s», «Caduca en 12 s» o «Caducada». */
export function tiempoRestante(caduca: number | null, ahora: number): string {
  if (caduca === null || !Number.isFinite(caduca)) return '';
  const segundos = Math.ceil((caduca - ahora) / 1000);
  if (segundos <= 0) return 'Caducada';
  const minutos = Math.floor(segundos / 60);
  const resto = segundos % 60;
  if (minutos === 0) return `Caduca en ${resto} s`;
  return resto === 0 ? `Caduca en ${minutos} min` : `Caduca en ${minutos} min ${resto} s`;
}

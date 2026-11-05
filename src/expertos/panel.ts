import type { BaseExpertos } from './base.js';

/** Lo que enseña la tarjeta «Apuntes» del panel: temas, archivos y dónde meterlos. */
export interface PanelApuntes {
  carpeta: string;
  temas: {
    nombre: string;
    carpeta: string;
    archivos: { archivo: string; trozos: number; motivo: string }[];
    instrucciones: string;
  }[];
}

/** Solo lectura; reindexa antes (como mucho una vez por minuto) para contar lo recién soltado. */
export async function panelApuntes(base: BaseExpertos): Promise<PanelApuntes> {
  await base.reindexar();
  return {
    carpeta: base.root,
    temas: base.nombres().map((nombre) => ({
      nombre,
      carpeta: base.carpeta(nombre),
      archivos: base.archivos(nombre),
      instrucciones: base.instrucciones(nombre),
    })),
  };
}

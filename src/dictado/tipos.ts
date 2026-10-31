/** Piezas que el dictado necesita del sistema (en Windows: windows.ts; en tests: falsas). */

/** La tecla que se mantiene pulsada. */
export interface TeclaDictado {
  start(alPulsar: () => void, alSoltar: () => void): Promise<void>;
  stop(): Promise<void>;
}

/** Dónde acaba el texto: la app con el foco. */
export interface EscritorDictado {
  /** true si el foco está en un campo de contraseña (o seguro). */
  campoSeguro(): Promise<boolean>;
  escribir(texto: string): Promise<void>;
}

/** Señal que se oye: empieza a grabar, termina, o no se puede. */
export type Aviso = 'graba' | 'fin' | 'no';

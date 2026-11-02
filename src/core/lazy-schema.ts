import { createRequire } from 'node:module';
import type * as Typebox from 'typebox';

/**
 * typebox, solo cuando hace falta un esquema.
 *
 * Son ~370 módulos ESM (~45 ms de cada arranque de `pa`) y cada herramienta construía su
 * esquema al importarse: `pa ayuda`, `pa estado` o `pa recordatorios` los pagaban sin
 * montar nunca un agente. Ahora cada esquema se construye la primera vez que se pide
 * (al montar las herramientas del agente) y desde entonces es SIEMPRE el mismo objeto,
 * igual que la constante de módulo de antes: misma lista de herramientas, mismos
 * nombres, descripciones, esquemas y permisos.
 *
 * El `require` de un ESM es síncrono en Node 24 (sin aviso): las fábricas de
 * herramientas siguen siendo síncronas.
 */
type TypeNamespace = typeof Typebox.Type;

let loaded: TypeNamespace | undefined;
const load = (): TypeNamespace => {
  loaded ??= (createRequire(import.meta.url)('typebox') as typeof Typebox).Type;
  return loaded;
};

/** El `Type` de typebox; se carga en la primera llamada (`Type.Object(...)`), no al importar. */
export const Type: TypeNamespace = new Proxy({} as TypeNamespace, {
  get: (_target, key) => (load() as unknown as Record<PropertyKey, unknown>)[key],
});

/** Esquema construido al primer uso y memorizado: cada llamada devuelve el mismo objeto. */
export function lazySchema<S>(build: () => S): () => S {
  let schema: { value: S } | undefined;
  return () => {
    schema ??= { value: build() };
    return schema.value;
  };
}

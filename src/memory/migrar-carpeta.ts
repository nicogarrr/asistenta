/**
 * Migración a la carpeta de memoria (src/memory/carpeta.ts), una sola vez y
 * sin perder nada.
 *
 * Antes la memoria estaba repartida en la carpeta de datos:
 *   memory/*.md              hechos por chat/tema   → memoria/notas/
 *   snapshot/PERFIL.md        perfil                 → memoria/PERFIL.md
 *   snapshot/MEMORIA.md       (heredado)             → memoria/MEMORIA.md
 *   skills/<id>/SKILL.md      habilidades            → memoria/procedimientos/
 *
 * Cómo se hace sin riesgo:
 * 1. Se COPIA cada fichero a su sitio nuevo y se comprueba byte a byte.
 *    Si en el destino ya hay un fichero distinto con ese nombre, el viejo
 *    no lo pisa: va a memoria/_conflictos/ para revisarlo a mano.
 * 2. Solo si todo cuadra, los originales se MUEVEN intactos a
 *    memoria-copia/<fecha>/ (la copia de seguridad son los propios
 *    originales) y se escribe memoria/.migrado.json.
 * 3. Si algo falla, los originales se quedan donde estaban, no hay marca, y
 *    el siguiente arranque lo reintenta.
 *
 * Sin imports de la app: lo llama ensureDirs() en paths.ts antes de que nada
 * lea la memoria.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const MARCA_MIGRADO = '.migrado.json';

export interface ResultadoMigracion {
  /** true si esta llamada movió algo. */
  hecho: boolean;
  copiados: number;
  conflictos: number;
  /** Carpeta con los originales (si hubo algo que mover). */
  copia?: string;
  errores: string[];
}

interface Origen {
  /** Fichero o carpeta de origen. */
  src: string;
  /** Destino equivalente. */
  dst: string;
  /** Nombre dentro de la copia de seguridad. */
  etiqueta: string;
}

function ficheros(p: string): string[] {
  const st = statSync(p);
  if (!st.isDirectory()) return [''];
  const out: string[] = [];
  for (const n of readdirSync(p)) {
    for (const r of ficheros(join(p, n))) out.push(r ? join(n, r) : n);
  }
  return out;
}

function sello(d: Date): string {
  const z = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

export function migrarMemoriaACarpeta(
  state: string,
  memoria: string,
  ahora: Date = new Date(),
): ResultadoMigracion {
  const res: ResultadoMigracion = { hecho: false, copiados: 0, conflictos: 0, errores: [] };
  const marca = join(memoria, MARCA_MIGRADO);
  if (existsSync(marca)) return res;
  const origenes: Origen[] = [
    { src: join(state, 'memory'), dst: join(memoria, 'notas'), etiqueta: 'memory' },
    {
      src: join(state, 'snapshot', 'PERFIL.md'),
      dst: join(memoria, 'PERFIL.md'),
      etiqueta: 'snapshot-PERFIL.md',
    },
    {
      src: join(state, 'snapshot', 'MEMORIA.md'),
      dst: join(memoria, 'MEMORIA.md'),
      etiqueta: 'snapshot-MEMORIA.md',
    },
    { src: join(state, 'skills'), dst: join(memoria, 'procedimientos'), etiqueta: 'skills' },
  ].filter((o) => existsSync(o.src));
  mkdirSync(memoria, { recursive: true, mode: 0o700 });
  if (!origenes.length) {
    writeFileSync(marca, JSON.stringify({ migrado: ahora.toISOString(), copiados: 0 }, null, 2));
    return res;
  }
  // 1. Copiar y verificar.
  for (const o of origenes) {
    for (const rel of ficheros(o.src)) {
      const de = rel ? join(o.src, rel) : o.src;
      let a = rel ? join(o.dst, rel) : o.dst;
      try {
        const bytes = readFileSync(de);
        if (existsSync(a) && !readFileSync(a).equals(bytes)) {
          a = join(memoria, '_conflictos', rel ? join(o.etiqueta, rel) : o.etiqueta);
          res.conflictos++;
        }
        if (!existsSync(a)) {
          mkdirSync(dirname(a), { recursive: true, mode: 0o700 });
          copyFileSync(de, a);
        }
        if (!readFileSync(a).equals(bytes)) throw new Error('la copia no coincide');
        res.copiados++;
      } catch (err) {
        res.errores.push(`${relative(state, de)}: ${String(err)}`);
      }
    }
  }
  if (res.errores.length) return res;
  // 2. Originales intactos a la copia de seguridad.
  const copia = join(state, 'memoria-copia', sello(ahora));
  mkdirSync(copia, { recursive: true, mode: 0o700 });
  res.copia = copia;
  for (const o of origenes) {
    const destino = join(copia, o.etiqueta);
    try {
      renameSync(o.src, destino);
    } catch {
      // Windows: si algo tiene el fichero abierto, al menos queda una copia;
      // el original se queda donde estaba (nadie lo vuelve a leer).
      try {
        cpSync(o.src, destino, { recursive: true });
      } catch (err) {
        res.errores.push(`copia de ${o.etiqueta}: ${String(err)}`);
      }
    }
  }
  if (res.errores.length) return res;
  writeFileSync(
    marca,
    JSON.stringify(
      { migrado: ahora.toISOString(), copiados: res.copiados, conflictos: res.conflictos, copia },
      null,
      2,
    ),
  );
  res.hecho = true;
  return res;
}

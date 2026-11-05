/**
 * Sitios guardados por nombre para los avisos al llegar/salir (src/llegada.ts).
 *
 * Nico manda su ubicación (o la comparte en directo) y dice «guarda esto como el
 * gimnasio»; desde ahí «cuando llegue al gimnasio recuérdame…» o «cuando salga del
 * gimnasio…» usan ese punto. Antes solo valían «casa» (PA_BRIEFING_LAT/LON) y nombres
 * de ciudad, así que el gimnasio, la oficina o casa de sus padres no se podían usar.
 */

/** Clave de comparación: sin artículo, tildes, mayúsculas ni comillas. */
export function sitioKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[«»"'“”.!?¿¡]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:el|la|los|las|mi|mis)\s+/, '');
}

/** «el gimnasio» → «al gimnasio»; «casa» → «a casa». */
export function aSitio(name: string): string {
  const m = /^el\s+(.+)$/.exec(name);
  return m ? `al ${m[1]}` : `a ${name}`;
}

/** «el gimnasio» → «del gimnasio»; «casa» → «de casa». */
export function deSitio(name: string): string {
  const m = /^el\s+(.+)$/.exec(name);
  return m ? `del ${m[1]}` : `de ${name}`;
}

/**
 * Un nombre en minúscula con artículo («el gimnasio», «la oficina», «mi trabajo»):
 * es un sitio de Nico, no una ciudad («La Coruña», con mayúscula, sí se busca).
 */
export function esSitioPropio(place: string): boolean {
  return /^(?:el|la|los|las|mi|mis)\s+[a-záéíóúñü]/u.test(place.trim());
}

/** Una posición vale para «guarda esto como…» si llegó hace menos de 30 min. */
export const SITIO_POSICION_MAX_MS = 30 * 60_000;

/**
 * «guarda esto como el gimnasio», «guarda donde estoy como la oficina», «apunta esta
 * ubicación como casa de mis padres». `explicito` = la frase habla de ubicación (no
 * solo «esto»): sin posición reciente se contesta igualmente con cómo hacerlo. null
 * si no es eso.
 */
export function guardarSitioIntent(
  text: string | undefined,
): { name: string; explicito: boolean } | null {
  if (!text) return null;
  const t = text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '');
  if (t.length > 120) return null;
  const m =
    /^(?:guarda(?:me)?|gu[aá]rdame|apunta|graba)\s+(esto|esta\s+ubicaci[oó]n|este\s+sitio|este\s+punto|esta\s+posici[oó]n|aqu[ií]|donde\s+estoy|mi\s+ubicaci[oó]n)\s+como\s+(.+)$/iu.exec(
      t,
    );
  if (!m?.[1] || !m[2]) return null;
  const name = m[2].replace(/^[«"“']+|[»"”']+$/g, '').trim();
  if (!name || name.length > 40 || name.split(' ').length > 5 || !sitioKey(name)) return null;
  return { name, explicito: !/^esto$/i.test(m[1]) };
}

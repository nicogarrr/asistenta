/**
 * ¿Es un correo masivo (boletín, lista, aviso automático)? Solo por las cabeceras, sin modelo:
 * List-Unsubscribe / List-Id (listas y boletines), Precedence: bulk|list|junk y
 * Auto-Submitted: auto-generated|auto-replied (RFC 3834). Lo usan los recordatorios por tema
 * del correo: «cuando hable de Indra…» no debe gastarse con el boletín diario de la bolsa.
 */
export function esMasivo(source: Buffer | string | undefined): boolean {
  const raw = (source ?? '').toString();
  const fin = raw.search(/\r?\n\r?\n/);
  const cabeceras = (fin >= 0 ? raw.slice(0, fin) : raw.slice(0, 16_000)).replace(
    /\r?\n[ \t]+/g,
    ' ',
  );
  return (
    /^(?:list-unsubscribe|list-id)\s*:/im.test(cabeceras) ||
    /^precedence\s*:\s*(?:bulk|list|junk)\b/im.test(cabeceras) ||
    /^auto-submitted\s*:\s*auto-(?:generated|replied)\b/im.test(cabeceras)
  );
}

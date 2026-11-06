/** «/precios on», «/precios apaga», «/precios ahora»… → la acción; cualquier otra cosa = ver estado. */
export function preciosAccion(args: string): 'on' | 'off' | 'ahora' | 'estado' {
  const a = args
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (/^(on|encender|enciende|enciendelo|activar|activa|si)$/.test(a)) return 'on';
  if (/^(off|apagar|apaga|apagalo|desactivar|desactiva|para|no)$/.test(a)) return 'off';
  if (/^(ahora|ya|barre|barrer|buscar|busca)$/.test(a)) return 'ahora';
  return 'estado';
}

export const PRECIOS_SOLO_DUENO =
  'El vigilante de errores de precio es solo para el dueño, en su chat privado.';

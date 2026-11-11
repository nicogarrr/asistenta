/**
 * «/correo vigilar on|off»: el aviso de correo nuevo (IDLE, solo lectura) encendido SOLO para
 * lo que no necesita modelo: las tarjetas de invitación de calendario («📅 ¿La apunto?») y los
 * recordatorios por tema («cuando hable con Marta…»). Sin el ojo con modelo ni un disparador
 * «correo», antes no salían nunca. No lee ni guarda nada más del correo: cada mensaje se mira,
 * se avisa si toca y se suelta (el ojo no lo recibe).
 */

export const VIGILAR_LIGERO_KEY = 'mail:vigilar-ligero';

export interface VigilarKv {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
}

/** ¿Lo encendió el dueño? Nace apagado. */
export function vigilarLigero(kv: VigilarKv): boolean {
  try {
    return kv.get(VIGILAR_LIGERO_KEY) === 'on';
  } catch {
    return false;
  }
}

export function setVigilarLigero(kv: VigilarKv, on: boolean): void {
  kv.set(VIGILAR_LIGERO_KEY, on ? 'on' : 'off');
}

/** «vigilar on», «vigilar apagar», «vigilar» (estado). null si no es esta orden. */
export function vigilarOrden(args: string): 'on' | 'off' | 'estado' | null {
  const m = /^vigila(?:r|ncia)?(?:\s+(.*))?$/i.exec(args.trim());
  if (!m) return null;
  const a = (m[1] ?? '').trim().toLowerCase();
  if (!a || /^(?:estado|\?)$/.test(a)) return 'estado';
  if (/^(?:on|si|sí|encender|enciende|activar|activa)$/.test(a)) return 'on';
  if (/^(?:off|no|apagar|apaga|desactivar|desactiva|para|parar)$/.test(a)) return 'off';
  return null;
}

export interface MotivosIdle {
  /** El ojo con modelo gratis está configurado y encendido. */
  ojo: boolean;
  /** Hay un disparador «correo» (o un script que lo quiere). */
  disparador: boolean;
  /** «/correo vigilar on». */
  ligero: boolean;
}

/** ¿Hace falta la conexión IDLE? (al arrancar y tras cada on/off). */
export function necesitaIdle(m: MotivosIdle): boolean {
  return m.ojo || m.disparador || m.ligero;
}

/**
 * Tras las tarjetas de invitación, los recordatorios y los disparadores: ¿se le pasa el correo
 * al ojo, se da por leído o se rechaza (el cursor no avanza)?
 */
export function trasAvisos(m: MotivosIdle): 'ojo' | 'leido' | 'rechazar' {
  if (m.ojo) return 'ojo';
  return m.disparador || m.ligero ? 'leido' : 'rechazar';
}

/** La respuesta de «/correo vigilar …». */
export function textoVigilar(o: {
  orden: 'on' | 'off' | 'estado';
  on: boolean;
  cuenta: boolean;
  otros: MotivosIdle;
}): string {
  const otros = [
    ...(o.otros.ojo ? ['el ojo'] : []),
    ...(o.otros.disparador ? ['un disparador «correo»'] : []),
  ];
  const sinCuenta =
    'Aún no tienes configurada la lectura del correo: «/correo estado» te dice qué falta.';
  const que =
    'las invitaciones de calendario («📅 ¿La apunto?») y tus recordatorios por tema («cuando hable con Marta…»)';
  if (o.orden === 'on')
    return [
      `👀 Vale: miro el correo nuevo solo para ${que}. No leo nada más ni gasto modelo.`,
      o.cuenta ? '' : sinCuenta,
      '«/correo vigilar off» para dejarlo.',
    ]
      .filter(Boolean)
      .join('\n');
  if (o.orden === 'off')
    return otros.length
      ? `Vale, quito el aviso ligero. Sigo mirando el correo nuevo porque lo usa ${otros.join(' y ')}.`
      : '🔕 Vale, ya no miro el correo nuevo. «/correo vigilar on» para volver.';
  if (o.on)
    return [
      `👀 Miro el correo nuevo solo para ${que}.`,
      o.cuenta ? '' : sinCuenta,
      '«/correo vigilar off» para dejarlo.',
    ]
      .filter(Boolean)
      .join('\n');
  return [
    otros.length
      ? `El correo nuevo ya lo miro porque lo usa ${otros.join(' y ')}; las invitaciones y los recordatorios por tema salen igual.`
      : `Ahora no miro el correo nuevo, así que no te llegan ${que}.`,
    otros.length ? '' : '«/correo vigilar on» lo enciende solo para eso (sin modelo, gratis).',
  ]
    .filter(Boolean)
    .join('\n');
}

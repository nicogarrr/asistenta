/**
 * Las recetas de los atajos 3–6 del iPhone para `/atajos` en Telegram (las 1 y 2 están
 * en src/webui/atajo.ts). Los nombres de las acciones son los de la app Atajos en
 * español. Todas usan la misma dirección del panel por Tailscale y el mismo token.
 */

/** Automatizaciones (llegar/salir de casa, resumen de las 8:00) y Salud/Calendario. */
export function recetasAutomatizaciones(panelUrl: string): string {
  const base = `${panelUrl}api/atajo`;
  return [
    '3) Automatizaciones (van solas, iOS 17 o más). App Atajos → Automatización → «+» → Llegar (o Salir) → Ubicación: tu casa → «Ejecutar inmediatamente». Acciones:',
    `• Obtener contenido de URL: ${base}/lugar`,
    '  Método POST, el mismo encabezado Authorization. Cuerpo JSON: evento = llegar (o salir), sitio = casa',
    '• Si «Contenido de la URL» tiene algún valor → Mostrar notificación (o Leer texto) con «Contenido de la URL»',
    'Saltan tus avisos de «cuando llegue a casa…» sin compartir la ubicación en Telegram; si no hay ninguno, no dice nada. Otro sitio guardado: pon su nombre en sitio («el gimnasio»).',
    '',
    'Resumen de la mañana: Automatización → «+» → Hora del día → 8:00, Diariamente → «Ejecutar inmediatamente». Acciones:',
    `• Obtener contenido de URL: ${base}/resumen, método POST, mismo encabezado`,
    '• Leer texto: «Contenido de la URL»',
    '',
    '4) Salud y Calendario a mi memoria (solo lo que tú elijas). Crea un atajo «Salud a Asistenta»:',
    '• Buscar muestras de salud: Tipo es Pasos, Fecha de inicio es hoy → Calcular estadísticas: Suma',
    '• (Opcional) Lo mismo con Minutos de ejercicio',
    `• Obtener contenido de URL: ${base}/datos, POST, mismo encabezado. Cuerpo JSON: tipo = salud, pasos = Estadísticas`,
    '  Campos que apunto: pasos, sueno_horas (horas, p. ej. 7,5) y ejercicio_min. Cualquier otro lo ignoro y te lo digo.',
    '• Mostrar notificación: «Contenido de la URL»',
    'Calendario: Buscar eventos del calendario (Fecha de inicio es hoy) → Repetir con cada: Texto «Hora de inicio · Título» → Combinar texto (nueva línea) → Obtener contenido de URL con tipo = calendario y eventos = Texto combinado.',
    'Guardo una línea por día en notas/salud.md y notas/agenda.md; si lo mandas otra vez ese día, la corrijo, no la repito. Ponlo en una automatización a las 22:00 si quieres que vaya solo.',
  ].join('\n');
}

/** Pagos con Apple Pay y el modo sin PC. */
export function recetasPagoYSinPc(): string {
  return [
    '5) Pagar desde el iPhone. Cuando me pidas preparar una compra, te mando aquí el carrito o el enlace de pago con un botón «Pagar con Apple Pay en Safari». Lo abres, revisas y pagas tú con Face ID. Yo nunca pago.',
    '',
    '6) Con el PC apagado. Crea otro atajo «Asistenta sin PC» (necesita Apple Intelligence):',
    '• Dictar texto',
    '• Usar modelo → En el dispositivo. Instrucción: «Contesta en 1 a 3 frases, en castellano:» + Texto dictado',
    '• Leer texto: «Modo sin conexión, sin tu memoria ni herramientas.» y luego la Respuesta',
    'Atajos no tiene «si falla, haz otra cosa»: si el PC está apagado, «Pregunta a Asistenta» se para con un error de conexión. Entonces di «Oye Siri, Asistenta sin PC».',
  ].join('\n');
}

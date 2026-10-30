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

/** Nombre legible en español para una clave de los datos del panel. */
export function etiquetaCampo(clave: string): string {
  const mapa: Record<string, string> = {
    id: 'ID',
    chatId: 'Chat',
    threadId: 'Hilo',
    thread: 'Hilo',
    sessionId: 'Sesión',
    createdAt: 'Creado',
    updatedAt: 'Actualizado',
    expiresAt: 'Caduca',
    checkedAt: 'Comprobado',
    lastSeen: 'Visto por última vez',
    status: 'Estado',
    ok: 'Resultado',
    valid: 'Válido',
    verified: 'Verificado',
    count: 'Total',
    entries: 'Entradas',
    items: 'Elementos',
    sessions: 'Sesiones',
    messages: 'Mensajes',
    scope: 'Ámbito',
    error: 'Error',
    model: 'Modelo',
    provider: 'Proveedor',
    threads: 'Conversaciones abiertas',
    uptimeSeconds: 'Tiempo encendido',
    proximoRecordatorio: 'Próximo recordatorio',
    proximaRutina: 'Próxima rutina',
    tool: 'Herramienta',
    reason: 'Motivo',
    question: 'Pregunta',
    title: 'Título',
    text: 'Texto',
    content: 'Contenido',
    kind: 'Tipo',
    tags: 'Etiquetas',
    lastHash: 'Último hash',
  };
  if (mapa[clave]) return mapa[clave];
  const limpio = clave.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

/**
 * Formatea fechas y duraciones según la clave: un epoch o ISO en un campo
 * «…At» sale como «30 oct 2026, 13:21» (hora local del equipo, o `zona`), y un
 * «…Seconds» como «1 d 2 h 3 min». Devuelve null si no hay nada que formatear.
 */
export function formatearCampo(clave: string, valor: unknown, zona?: string): string | null {
  const duracion = (segundosTotales: number): string => {
    const s = Math.max(0, Math.round(segundosTotales));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d} d ${h} h ${m} min`;
    if (h > 0) return `${h} h ${m} min`;
    if (m > 0) return `${m} min ${s % 60} s`;
    return `${s} s`;
  };
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    if (/(Seconds|Secs)$/.test(clave)) return duracion(valor);
    if (/(Duration|Elapsed)Ms$|^(durationMs|elapsedMs)$/.test(clave)) return duracion(valor / 1000);
  }
  if (!/(At|_at)$|^(date|fecha|timestamp|ts|lastSeen)$/.test(clave)) return null;
  // Una fecha sin hora («2026-10-25») es un día, no la medianoche UTC: se
  // formatea en UTC para que no salga «0:00»/«2:00» ni el día anterior.
  if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    const dia = Date.parse(`${valor}T00:00:00Z`);
    if (!Number.isFinite(dia)) return null;
    return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(dia),
    );
  }
  let ms = Number.NaN;
  if (typeof valor === 'number' && Number.isFinite(valor)) {
    if (valor >= 1e12) ms = valor;
    else if (valor >= 1e9) ms = valor * 1000;
  } else if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(valor)) {
    ms = Date.parse(valor);
  }
  if (!Number.isFinite(ms)) return null;
  try {
    return new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: zona,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Texto en español para un fallo de la API del panel. Usa el mensaje que manda
 * el servidor (p. ej. «Objetivos aún no disponibles») en vez de solo el código.
 */
export function mensajeDeError(estado: number, cuerpo: unknown): string {
  const detalle =
    cuerpo &&
    typeof cuerpo === 'object' &&
    typeof (cuerpo as { error?: unknown }).error === 'string'
      ? String((cuerpo as { error: string }).error).trim()
      : '';
  if (estado === 401) return 'Token rechazado. Pega el token correcto arriba.';
  if (estado === 500 || (estado > 500 && !detalle)) {
    return 'Error interno del asistente. Revisa el registro local y vuelve a intentarlo.';
  }
  if (estado === 503) {
    return `${detalle || 'No disponible ahora mismo'}. Si el asistente está arrancando, reintenta en unos segundos.`;
  }
  if (detalle) return `${detalle.replace(/\.$/, '')}.`;
  return `El panel respondió con el código ${estado}.`;
}

/** Una entrada de memoria lista para pintar. */
export interface EntradaMemoria {
  texto: string;
  meta: string;
}

/**
 * Separa la memoria vigente de la sustituida (que el almacén conserva para
 * auditar) y prepara texto + «fecha · #etiquetas». Devuelve null si los datos
 * no tienen forma de memoria, para que el panel caiga a la vista genérica.
 */
export function resumenMemoria(
  datos: unknown,
): { vigentes: EntradaMemoria[]; sustituidas: EntradaMemoria[] } | null {
  let lista: unknown = datos;
  if (lista && typeof lista === 'object' && !Array.isArray(lista)) {
    const registro = lista as Record<string, unknown>;
    lista = Array.isArray(registro.entries) ? registro.entries : registro.items;
  }
  if (!Array.isArray(lista)) return null;
  const vigentes: EntradaMemoria[] = [];
  const sustituidas: EntradaMemoria[] = [];
  for (const item of lista) {
    if (!item || typeof item !== 'object') return null;
    const e = item as Record<string, unknown>;
    const texto =
      typeof e.text === 'string' ? e.text : typeof e.content === 'string' ? e.content : '';
    if (!texto) return null;
    const partes: string[] = [];
    if (typeof e.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date)) {
      const [a, m, d] = e.date.split('-');
      partes.push(`${d}/${m}/${a}`);
    }
    if (Array.isArray(e.tags) && e.tags.length) {
      partes.push(
        e.tags
          .filter((t) => typeof t === 'string' && t)
          .map((t) => `#${t}`)
          .join(' '),
      );
    }
    const entrada = { texto, meta: partes.filter(Boolean).join(' · ') };
    if (typeof e.supersededBy === 'string' && e.supersededBy) sustituidas.push(entrada);
    else vigentes.push(entrada);
  }
  return { vigentes, sustituidas };
}

/** «2 de 3 pasos hechos», o '' si no hay plan. */
export function progresoPlan(plan: unknown): string {
  if (!Array.isArray(plan) || plan.length === 0) return '';
  const hechos = plan.filter(
    (p) => p && typeof p === 'object' && (p as { done?: unknown }).done === true,
  ).length;
  return `${hechos} de ${plan.length} ${plan.length === 1 ? 'paso hecho' : 'pasos hechos'}`;
}

/** «Pensando… 12 s» / «Pensando… 1 min 05 s» mientras el agente responde. */
export function textoEspera(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `Pensando… ${s} s`;
  const resto = s % 60;
  return `Pensando… ${Math.floor(s / 60)} min ${resto < 10 ? '0' : ''}${resto} s`;
}

/** Título de la pestaña: «(2) Asistenta · Panel local» si hay aprobaciones esperando. */
export function tituloPestana(pendientes: number): string {
  const base = 'Asistenta · Panel local';
  return typeof pendientes === 'number' && pendientes > 0
    ? `(${Math.floor(pendientes)}) ${base}`
    : base;
}

/** Lo que una fila de «Sesiones» enseña: título, cuándo/dónde y un extracto. */
export interface ResumenSesion {
  titulo: string;
  meta: string;
  extracto: string;
}

/**
 * Acepta tanto `Session` (recent: id, scope, title, startedAt, endedAt, summary)
 * como `SessionHit` (search: sessionId, title, summary, snippet, at).
 */
export function resumenSesion(item: unknown, indice: number, ahora: number): ResumenSesion {
  if (typeof item === 'string') return { titulo: item, meta: '', extracto: '' };
  const r =
    item && typeof item === 'object'
      ? (item as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const titulo = texto(r.title) || texto(r.name) || `Conversación ${indice + 1}`;
  const partes: string[] = [];
  const cuando =
    typeof r.startedAt === 'number' ? r.startedAt : typeof r.at === 'number' ? r.at : null;
  if (cuando !== null && Number.isFinite(cuando) && cuando > 0) {
    const d = new Date(cuando);
    const hoy = new Date(ahora);
    const ayer = new Date(ahora - 86_400_000);
    const dos = (n: number): string => (n < 10 ? '0' : '') + n;
    const hora = `${dos(d.getHours())}:${dos(d.getMinutes())}`;
    const mismoDia = (a: Date, b: Date): boolean =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    if (mismoDia(d, hoy)) partes.push(`Hoy, ${hora}`);
    else if (mismoDia(d, ayer)) partes.push(`Ayer, ${hora}`);
    else
      partes.push(
        `${dos(d.getDate())}/${dos(d.getMonth() + 1)}${d.getFullYear() === hoy.getFullYear() ? '' : `/${d.getFullYear()}`}, ${hora}`,
      );
  }
  if (r.endedAt === null && typeof r.startedAt === 'number') partes.push('en curso');
  const ambito = texto(r.scope);
  if (/^telegram:(group|grupo)/.test(ambito)) partes.push('Grupo de Telegram');
  else if (ambito.startsWith('telegram:')) partes.push('Telegram');
  else if (ambito.startsWith('panel') || ambito.startsWith('web')) partes.push('Panel');
  else if (ambito.startsWith('cli')) partes.push('Terminal');
  let extracto = texto(r.snippet) || texto(r.summary);
  if (extracto.length > 220) extracto = `${extracto.slice(0, 217).trimEnd()}…`;
  return { titulo, meta: partes.join(' · '), extracto };
}

/**
 * Qué decir al lector de pantalla cuando cambia el número de aprobaciones.
 * Solo se anuncia lo que sube (o lo que ya había al abrir); nada si baja o no cambia,
 * para que el sondeo de cada 15 s no repita la tarjeta entera.
 */
export function anuncioPendientes(antes: number | null, ahora: number): string {
  const n = Math.max(0, Math.floor(Number(ahora) || 0));
  const plural = (k: number): string =>
    k === 1 ? '1 aprobación pendiente' : `${k} aprobaciones pendientes`;
  if (antes === null || antes === undefined) return n > 0 ? `Tienes ${plural(n)}.` : '';
  const nuevas = n - Math.max(0, Math.floor(Number(antes) || 0));
  if (nuevas <= 0) return '';
  return `${nuevas === 1 ? 'Nueva aprobación' : `${nuevas} aprobaciones nuevas`}: ${plural(n)}.`;
}

/** Nombre legible de un ámbito de memoria («telegram:dm:123#main» → «Telegram privado 123 · hilo main»). */
export function etiquetaAmbito(ambito: string): string {
  if (!ambito || ambito === 'local') return 'Local (este PC)';
  var almohadilla = ambito.indexOf('#');
  var base = almohadilla >= 0 ? ambito.slice(0, almohadilla) : ambito;
  var hilo = almohadilla >= 0 ? ambito.slice(almohadilla + 1) : '';
  var partes = base.split(':');
  var tipos: Record<string, string> = {
    dm: 'privado',
    private: 'privado',
    group: 'grupo',
    supergroup: 'grupo',
  };
  var texto = base;
  if (partes[0] === 'telegram' && partes.length >= 3) {
    texto = `Telegram ${tipos[partes[1] ?? ''] || partes[1]} ${partes.slice(2).join(':')}`;
  }
  return hilo ? `${texto} · hilo ${hilo}` : texto;
}

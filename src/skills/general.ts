/**
 * Habilidades generales que vienen sembradas (pedido de Nico, 31 oct: «Todas,
 * que sean generales»). Son recetas, no código: usan las herramientas que ya
 * hay (correo, calendario, navegador, recordatorios, memoria) y el auto-chequeo
 * (selfcheck.ts) dice cuáles se pueden usar hoy según lo que esté configurado.
 *
 * Reglas, las mismas que builtin.ts: se siembran una vez, nunca pisan una
 * edición del dueño (ni la reactivan si la quitó), y PA_GENERAL_SKILLS=0 no
 * siembra nada. Todas las que actúan fuera van con outward: true: los pasos
 * que envían, reservan o encienden algo pasan por el permiso de siempre.
 */
import { log } from '../log.js';
import { type SkillStore, slugify } from './store.js';
import type { SkillDraft } from './types.js';

const CATEGORY = 'habilidades';

export const GENERAL_SKILLS: readonly SkillDraft[] = [
  {
    name: 'Facturas y suscripciones',
    description: 'Avisa antes de cada cobro o renovación que llega por correo.',
    category: CATEGORY,
    whenToUse: '¿qué me van a cobrar?, avísame antes de renovaciones, facturas o suscripciones',
    steps: [
      'Buscar en el correo facturas, recibos y avisos de renovación de los últimos 60 días',
      'Sacar de cada uno el servicio, el importe y la fecha del próximo cobro',
      'Responder con una lista corta ordenada por fecha',
      'Ofrecer un recordatorio dos días antes de cada cobro y crearlo solo si el dueño dice que sí',
    ],
    outward: false,
    needs: ['correo'],
  },
  {
    name: 'Viajes',
    description: 'Junta vuelos, trenes y hoteles de los correos de confirmación.',
    category: CATEGORY,
    whenToUse: '¿cuándo es mi vuelo?, mis viajes, check-in, reservas de tren u hotel',
    steps: [
      'Buscar en el correo confirmaciones de vuelo, tren y hotel futuras',
      'Sacar fecha, hora, origen, destino, localizador y enlace de check-in',
      'Responder con el próximo viaje primero',
      'Ofrecer un recordatorio para el check-in y otro antes de salir; crearlos solo si dice que sí',
    ],
    outward: false,
    needs: ['correo'],
  },
  {
    name: 'Reservas por web',
    description:
      'Prepara una reserva (restaurante, médico, peluquería) y la envía solo con permiso.',
    category: CATEGORY,
    whenToUse: 'resérvame, pide cita, mesa para, cita en la peluquería o el médico',
    steps: [
      'Preguntar lo que falte: sitio, día, hora y personas',
      'Abrir la web del sitio con el navegador y rellenar el formulario con sus datos',
      'Parar antes de enviar y enseñar en una línea lo que se va a reservar',
      'Enviar solo si el dueño aprueba; nunca pagar ni dar datos de tarjeta',
      'Contestar con la confirmación y ofrecer apuntarlo en el calendario',
    ],
    outward: true,
    needs: ['navegador'],
  },
  {
    name: 'Cumpleaños',
    description: 'Recuerda cumpleaños y prepara la felicitación.',
    category: CATEGORY,
    whenToUse: 'cumpleaños de esta semana, recuérdame cumpleaños, felicitar a alguien',
    steps: [
      'Mirar en el calendario y en la memoria los cumpleaños de los próximos 7 días',
      'Avisar al dueño con el nombre y el día',
      'Si lo pide, redactar una felicitación corta con su tono y enseñarla',
      'No enviar nada a nadie: el dueño la manda o aprueba el envío',
    ],
    outward: true,
    needs: ['calendario'],
  },
  {
    name: 'Casa inteligente',
    description: 'Luces y enchufes con Home Assistant local, solo si está configurado.',
    category: CATEGORY,
    whenToUse: 'enciende o apaga la luz, el enchufe, la casa',
    steps: [
      'Comprobar que Home Assistant está configurado en este PC; si no, decir qué falta y parar',
      'Buscar el dispositivo por nombre y confirmar cuál es si hay dudas',
      'Pedir permiso antes de encender o apagar nada',
      'Decir en una línea cómo ha quedado',
    ],
    outward: true,
    needs: ['casa'],
  },
  {
    name: 'Notas de voz con memoria',
    description: 'Guarda lo que dices en notas de voz y lo encuentra después.',
    category: CATEGORY,
    whenToUse: '¿qué dije de…?, guarda esta nota de voz, busca en mis notas de voz',
    steps: [
      'Transcribir la nota de voz',
      'Guardar en la memoria una línea con la fecha y lo importante',
      'Para «¿qué dije de…?», buscar en la memoria y responder con la fecha y la frase',
    ],
    outward: false,
    needs: ['notas-voz'],
  },
];

export function seedGeneralSkills(
  store: SkillStore,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const created: string[] = [];
  if (env.PA_GENERAL_SKILLS === '0') return created;
  for (const draft of GENERAL_SKILLS) {
    const id = slugify(draft.name);
    try {
      if (store.read(id)) continue;
      created.push(store.save(draft));
    } catch (err) {
      log.warn('general skill seed failed', { id, err: String(err) });
    }
  }
  return created;
}

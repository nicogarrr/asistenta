/**
 * «/voz diagnostico» (Nico, 7 nov: «tarda muchísimo en contestarme al hablar»): una ida
 * y vuelta de una frase en este mismo PC, etapa por etapa, para saber dónde se va el
 * tiempo sin ver su PC: la voz dice una frase de prueba, whisper la oye, el modelo
 * contesta (sin herramientas ni historial) y la voz dice la respuesta. Cada etapa tiene
 * su tope y un fallo no para las demás.
 */
import { availableParallelism } from 'node:os';

export interface DiagnosticoVozDeps {
  /** La voz del PC: audio de la frase, o null si no hay. */
  speak(text: string): Promise<{ data: Buffer; mimeType: string } | null>;
  transcribe(audio: Buffer, mime: string): Promise<string>;
  /** El modelo principal, una respuesta corta sin herramientas. */
  pensar(text: string): Promise<string>;
  /** Qué voz habla («supertonic-f2», «kokoro (… aún sin descargar)»). */
  voz?: string;
  /** Qué whisper oye («turbo», «small»). */
  oido?: string;
  /** Con qué modelo piensa. */
  modelo?: string;
  ahora?: () => number;
  topeMs?: { voz?: number; oir?: number; pensar?: number };
}

export interface EtapaDiagnostico {
  etapa: 'voz' | 'oir' | 'pensar' | 'respuesta';
  ms: number;
  ok: boolean;
  detalle: string;
}

export const FRASE_PRUEBA = 'Hola Asistenta, ¿qué día es hoy?';

const NOMBRES: Record<EtapaDiagnostico['etapa'], string> = {
  voz: 'Voz (frase de prueba)',
  oir: 'Oír (whisper)',
  pensar: 'Pensar (modelo, sin herramientas)',
  respuesta: 'Voz de la respuesta',
};

async function medir<T>(
  ahora: () => number,
  topeMs: number,
  fn: () => Promise<T>,
): Promise<{ ms: number; ok: true; valor: T } | { ms: number; ok: false; motivo: string }> {
  const t0 = ahora();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const valor = await Promise.race([
      fn(),
      new Promise<never>((_, ko) => {
        timer = setTimeout(
          () => ko(new Error(`más de ${Math.round(topeMs / 1000)} s sin terminar`)),
          topeMs,
        );
        timer.unref?.();
      }),
    ]);
    return { ms: ahora() - t0, ok: true, valor };
  } catch (err) {
    return {
      ms: ahora() - t0,
      ok: false,
      motivo: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function diagnosticoVoz(deps: DiagnosticoVozDeps): Promise<EtapaDiagnostico[]> {
  const ahora = deps.ahora ?? Date.now;
  const tope = { voz: 30_000, oir: 60_000, pensar: 45_000, ...deps.topeMs };
  const etapas: EtapaDiagnostico[] = [];

  const voz = await medir(ahora, tope.voz, () => deps.speak(FRASE_PRUEBA));
  const audio = voz.ok && voz.valor && voz.valor.data.length > 0 ? voz.valor : null;
  etapas.push({
    etapa: 'voz',
    ms: voz.ms,
    ok: audio !== null,
    detalle: voz.ok ? (audio ? (deps.voz ?? '') : 'sin audio del PC') : voz.motivo,
  });

  let oido = FRASE_PRUEBA;
  if (audio) {
    const r = await medir(ahora, tope.oir, () => deps.transcribe(audio.data, audio.mimeType));
    if (r.ok && r.valor.trim()) oido = r.valor.trim();
    etapas.push({
      etapa: 'oir',
      ms: r.ms,
      ok: r.ok && r.valor.trim() !== '',
      detalle: r.ok ? `«${r.valor.trim()}»${deps.oido ? ` · ${deps.oido}` : ''}` : r.motivo,
    });
  } else {
    etapas.push({ etapa: 'oir', ms: 0, ok: false, detalle: 'sin audio que oír' });
  }

  const p = await medir(ahora, tope.pensar, () => deps.pensar(oido));
  const respuesta = p.ok ? p.valor.trim() : '';
  etapas.push({
    etapa: 'pensar',
    ms: p.ms,
    ok: p.ok && respuesta !== '',
    detalle: p.ok
      ? `${respuesta ? `«${respuesta.slice(0, 80)}»` : 'respuesta vacía'}${deps.modelo ? ` · ${deps.modelo}` : ''}`
      : p.motivo,
  });

  const r2 = await medir(ahora, tope.voz, () => deps.speak(respuesta || 'Vale.'));
  etapas.push({
    etapa: 'respuesta',
    ms: r2.ms,
    ok: r2.ok && r2.valor !== null,
    detalle: r2.ok ? (r2.valor ? '' : 'sin audio del PC') : r2.motivo,
  });
  return etapas;
}

const ms = (n: number): string => `${Math.round(n).toLocaleString('es-ES')} ms`;

/**
 * El mensaje de Telegram: una línea por etapa, el total, la más lenta y, si se sabe, el
 * modelo de reserva (con uno, si el principal está saturado o sin cuota se cambia al
 * momento en vez de esperar y reintentar).
 */
export function textoDiagnostico(
  etapas: readonly EtapaDiagnostico[],
  nucleos = availableParallelism(),
  reserva?: readonly string[],
): string {
  const lineas = etapas.map((e) => {
    const marca = e.ok ? '✅' : '❌';
    const detalle = e.detalle ? ` — ${e.detalle}` : '';
    return `${marca} ${NOMBRES[e.etapa]}: ${ms(e.ms)}${detalle}`;
  });
  const total = etapas.reduce((s, e) => s + e.ms, 0);
  const lenta = [...etapas].sort((a, b) => b.ms - a.ms)[0];
  return [
    '🎙️ Diagnóstico de voz (ida y vuelta en este PC)',
    ...lineas,
    `Total: ${ms(total)} · ${nucleos} núcleos`,
    lenta ? `Lo más lento: ${NOMBRES[lenta.etapa].toLowerCase()}.` : '',
    reserva === undefined
      ? ''
      : reserva.length > 0
        ? `Modelo de reserva si el principal se satura: ${reserva.join(', ')}.`
        : 'Sin modelo de reserva: si el modelo se satura, espera y reintenta en vez de cambiar a otro (PA_FALLBACK_MODEL en .env).',
  ]
    .filter(Boolean)
    .join('\n');
}

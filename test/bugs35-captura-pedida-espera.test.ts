import { describe, expect, it } from 'vitest';
import { pidioAdjunto, ultimaRespuesta } from '../src/bandeja/captura.js';

// bugs-35 (lead de bugs-34 sobre #2322): `pidioAdjunto` miraba solo si en los últimos 400
// caracteres de la última respuesta salían un verbo de petición y «captura/PDF/enlace».
// Eso saltaba también cuando Asistenta EXPLICABA la bandeja («si me mandas un enlace a
// secas, lo guardo en la bandeja») o pedía algo y luego seguía con otra cosa: el siguiente
// enlace de Nico ya no iba a la bandeja. Y contaba aunque el hilo no estuviera esperando
// (un turno a medias, o uno que acabó en error).

const now = Date.UTC(2026, 10, 11, 12, 0);
const at = now - 60_000;

describe('«me lo acabas de pedir» solo si el hilo de verdad espera eso', () => {
  it('explicar la bandeja no es pedir nada', () => {
    for (const text of [
      'Listo. Si me mandas un enlace a secas, lo guardo en la bandeja y a las 21:30 te lo resumo.',
      'Puedes mandarme enlaces, PDFs o capturas cuando quieras: van a tu bandeja.',
      'Recuerda: mándame los enlaces que quieras leer luego y te los guardo en la bandeja.',
    ])
      expect(pidioAdjunto({ text, at }, now), text).toBe(false);
  });

  it('pedir algo y seguir con otra cosa no deja el hilo esperando el archivo', () => {
    const text =
      'Pásame el PDF cuando lo tengas. Mientras tanto, te he apuntado la cita del dentista ' +
      'el jueves a las 10:00 y he quitado la del viernes. También he mirado el tiempo: ' +
      'mañana llueve en Gijón, mejor coge paraguas. Y he dejado listo el resumen de GerarAI.';
    expect(pidioAdjunto({ text, at }, now)).toBe(false);
  });

  it('las peticiones de verdad siguen contando (cierre del mensaje)', () => {
    for (const text of [
      'No veo bien el fallo. ¿Me mandas una captura de la pantalla?',
      'Vale, pásame el PDF y lo reviso.',
      'Si quieres, envíame el enlace del piso y lo miro.',
      'Sube la foto del ticket y lo apunto en gastos.',
      'Ese aviso sale cuando falla el arranque. Mándame una captura del error y lo miro. Gracias.',
    ])
      expect(pidioAdjunto({ text, at }, now), text).toBe(true);
  });

  it('ultimaRespuesta: solo un turno que terminó en esa respuesta espera algo', () => {
    const ask = (stopReason: string) => ({
      role: 'assistant',
      stopReason,
      timestamp: at,
      content: [{ type: 'text', text: '¿Me mandas una captura del error?' }],
    });
    expect(ultimaRespuesta([ask('stop')])).toEqual({
      text: '¿Me mandas una captura del error?',
      at,
    });
    // A medias (iba a usar una herramienta), cortado o con error: no espera nada.
    expect(ultimaRespuesta([ask('toolUse')])).toBeNull();
    expect(ultimaRespuesta([ask('aborted')])).toBeNull();
    expect(ultimaRespuesta([ask('error')])).toBeNull();
    // Si lo último es de Nico (o una herramienta), tampoco.
    expect(
      ultimaRespuesta([ask('stop'), { role: 'user', content: 'hola', timestamp: now }]),
    ).toBeNull();
    expect(ultimaRespuesta([])).toBeNull();
  });
});

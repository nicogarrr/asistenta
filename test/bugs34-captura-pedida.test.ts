import { describe, expect, it } from 'vitest';
import { PIDIO_ADJUNTO_MS, pidioAdjunto } from '../src/bandeja/captura.js';

// bugs-34: con la captura automática de la bandeja, si Asistenta acababa de pedir «mándame
// una captura del error» y Nico la mandaba a secas, la foto acababa «📥 guardada en la
// bandeja» y la conversación se quedaba esperando. Lo mismo con «pásame el PDF».

const now = Date.UTC(2026, 10, 11, 12, 0);

describe('lo que llega a secas justo después de pedirlo es la respuesta', () => {
  it('detecta la petición reciente de una foto, captura, PDF o enlace', () => {
    for (const text of [
      'No veo bien el fallo. ¿Me mandas una captura de la pantalla?',
      'Vale, pásame el PDF y lo reviso.',
      'Si quieres, envíame el enlace del piso y lo miro.',
      'Sube la foto del ticket y lo apunto en gastos.',
    ])
      expect(pidioAdjunto({ text, at: now - 60_000 }, now)).toBe(true);
  });

  it('no cuenta si es viejo o si no pedía nada', () => {
    expect(
      pidioAdjunto({ text: 'Mándame una captura del error.', at: now - PIDIO_ADJUNTO_MS - 1 }, now),
    ).toBe(false);
    expect(
      pidioAdjunto({ text: 'Hecho: te he apuntado la cita del dentista.', at: now }, now),
    ).toBe(false);
    // Decir que ya lo mandó no es pedirlo.
    expect(pidioAdjunto({ text: 'Te he mandado el PDF por correo.', at: now }, now)).toBe(false);
    expect(pidioAdjunto({ text: '¿Puedes enviarme el enlace?', at: now }, now)).toBe(true);
    expect(pidioAdjunto(null, now)).toBe(false);
  });
});

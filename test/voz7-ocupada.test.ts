import { describe, expect, it } from 'vitest';
import { runPanelChat } from '../src/daemon/panel-chat.js';
import { type EventoVoz, OCUPADA, turnoVoz } from '../src/webui/voz-turno.js';

describe('/voz con Asistenta ocupada en otra cosa: lo dice, no se queda callada (voz7)', () => {
  it('runPanelChat avisa si el hilo ya tiene un turno en marcha', async () => {
    let soltar: (() => void) | undefined;
    const enMarcha = new Promise<void>((r) => {
      soltar = r;
    });
    const hilo = { key: 'k', generation: 0, tail: enMarcha as Promise<unknown>, active: true };
    let avisos = 0;
    const p = runPanelChat(hilo, 'hola', {
      remember: () => {},
      runTurn: async (_t, _s, out) => out.answer('Hola.'),
      onOcupado: () => {
        avisos++;
      },
    });
    expect(avisos).toBe(1);
    hilo.active = false;
    soltar?.();
    expect((await p).text).toBe('Hola.');
  });

  it('con el hilo libre no avisa', async () => {
    const hilo = {
      key: 'k2',
      generation: 0,
      tail: Promise.resolve() as Promise<unknown>,
      active: false,
    };
    let avisos = 0;
    await runPanelChat(hilo, 'hola', {
      remember: () => {},
      runTurn: async (_t, _s, out) => out.answer('Hola.'),
      onOcupado: () => {
        avisos++;
      },
    });
    expect(avisos).toBe(0);
  });

  it('/voz dice «Un momento…» ya y luego la respuesta entera', async () => {
    const ev: EventoVoz[] = [];
    await turnoVoz(
      Buffer.alloc(4),
      'audio/wav',
      {
        transcribe: async () => '¿qué hora es?',
        chat: async (_t, o) => {
          o.onOcupado();
          await new Promise((r) => setTimeout(r, 50));
          return { text: 'Son las cinco.' };
        },
        speak: async (t) => ({ data: Buffer.from(t), mimeType: 'audio/mpeg' }),
      },
      (e) => ev.push(e),
      { inicio: Date.now(), recibirMs: 0 },
    );
    const frases = ev.flatMap((e) => (e.tipo === 'frase' ? [e.texto] : []));
    expect(frases).toEqual([OCUPADA, 'Son las cinco.']);
  });
});

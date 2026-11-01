import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { WEB_DEMO_RETRY, webDemoFollowUp } from '../src/teach-demo-web.js';
import {
  CONVERSACION_OFF_HINT,
  conversacionOffAnswer,
  MIC_OFF_TEXT,
  WAKE_AGAIN_ASK,
} from '../src/wake-texts.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const web = readFileSync(new URL('../src/teach-demo-web.ts', import.meta.url), 'utf8');

describe('grabar en una web y la voz sin mandar a /learn web, /wake on ni /conversacion off', () => {
  it('la grabación en una web pregunta y entiende la respuesta normal', () => {
    expect(web).not.toMatch(/con \/learn web/);
    expect(WEB_DEMO_RETRY).toBe('¿Lo intento otra vez? Dime «sí».');
    expect(webDemoFollowUp(`No pude abrir el navegador para grabar. ${WEB_DEMO_RETRY}`)).toBe(
      'retry',
    );
    expect(
      webDemoFollowUp(
        'La grabación en a.com caducó (más de 30 min) y no se ha guardado nada. Si quieres empezar otra, pásame el enlace.',
      ),
    ).toBe('link');
    expect(webDemoFollowUp('¿En qué web te miro? Pásame el enlace.')).toBe('link');
    expect(webDemoFollowUp('Grabando la demostración en a.com.')).toBeNull();
    expect(cli).toContain("askWebDemo(inbound, msg, webArg[1] ?? '');");
    expect(cli).toContain("askWebDemo(inbound, web, '');");
  });

  it('el micrófono se vuelve a encender con «sí»', () => {
    expect(cli).not.toContain('/wake on');
    expect(cli).not.toContain('/conversacion on.');
    expect(MIC_OFF_TEXT).toBe(
      'Has pulsado el botón del mando pero el micrófono está apagado. ¿Lo enciendo? Dime «sí».',
    );
    expect(WAKE_AGAIN_ASK).toBe('¿Vuelvo a escuchar? Dime «sí».');
    expect(cli).toContain('void notifyLastChat(MIC_OFF_TEXT, WAKE_ON_ASK)');
    expect(cli).toContain("const WAKE_ON_ASK = { command: 'wake', args: 'on' };");
  });

  it('la conversación por voz se apaga diciendo «apágala»', () => {
    expect(cli).not.toContain('/conversacion off');
    expect(CONVERSACION_OFF_HINT).toBe('Si quieres apagarla, dime «apágala».');
    for (const t of ['apágala', 'Apaga la conversación', 'quítala', 'desactívala.']) {
      expect(conversacionOffAnswer(t), t).toBe('off');
    }
    expect(conversacionOffAnswer('apaga la tele')).toBeNull();
    expect(conversacionOffAnswer('hola')).toBeNull();
    const p = new PreguntasPendientes();
    p.ask('c', 'conversacion', { answer: conversacionOffAnswer });
    expect(p.consume('c', 'apágala')).toEqual({ name: 'conversacion', args: 'off' });
    expect(cli).toContain(
      "preguntas.ask(chatKey(inbound), 'conversacion', { answer: conversacionOffAnswer });",
    );
  });
});

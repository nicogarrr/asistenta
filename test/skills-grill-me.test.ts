import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_QUESTIONS,
  GRILL_DROPPED,
  GRILL_INTRO,
  GrillMe,
  grillTrigger,
} from '../src/skills/grill.js';

/** Telegram falso: guarda lo que Asistenta contesta. */
function fakeChat() {
  const sent: string[] = [];
  return { sent, reply: async (t: string) => void sent.push(t) };
}

/** Modelo falso: preguntas numeradas para el encargo, resumen para las respuestas. */
function fakeModel() {
  const calls: string[] = [];
  const llm = async (system: string, user: string) => {
    calls.push(user);
    if (system.includes('UNA ronda')) {
      return '1. ¿Qué días? (Propongo: lunes a viernes)\n2. ¿A qué hora? (Propongo: 8:00)\n3. ¿Por Telegram? (Propongo: sí)\n4. ¿Incluyo el tráfico? (Propongo: no)';
    }
    return 'Te mandaré el tiempo de lunes a viernes a las 8:00 por Telegram.\nSin tráfico.\nLo verás mañana a las 8.';
  };
  return { calls, llm };
}

describe('preguntas antes de lo grande (grill-me)', () => {
  it.each([
    'Organízame la semana que viene con el gimnasio, la compra y las clases',
    'Quiero montar una rutina para revisar el correo cada mañana',
    'aprende a avisarme de la lluvia',
    'Busca vuelos a Roma, luego mira hoteles cerca del centro y después hazme un presupuesto',
  ])('«%s» se pregunta antes', (t) => {
    expect(grillTrigger(t)).not.toBeNull();
  });

  it.each([
    'pon la tele',
    'qué tiempo hace',
    'recuérdame mañana a las 9 llamar a mamá',
    'Sube el volumen de la tele y luego pon la radio después',
    'Organízame la semana, hazlo ya',
    'aprende a avisarme de la lluvia sin preguntas',
  ])('«%s» no se pregunta', (t) => {
    expect(grillTrigger(t)).toBeNull();
  });

  it('encargo grande: una ronda numerada, resumen y empieza solo con «sí»', async () => {
    const g = new GrillMe();
    const chat = fakeChat();
    const model = fakeModel();
    const deps = { llm: model.llm, reply: chat.reply };
    const first = await g.handle(
      'c',
      'Quiero montar una rutina que me mande el tiempo cada mañana',
      deps,
    );
    expect(first.kind).toBe('handled');
    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0]).toContain(GRILL_INTRO);
    expect(chat.sent[0]).toMatch(/1\. .*\n2\. .*\n3\. .*\n4\. /);
    expect(chat.sent[0]).toContain('hazlo ya');

    expect((await g.handle('c', 'sí, pero a las 7:30', deps)).kind).toBe('handled');
    expect(chat.sent[1]).toMatch(/^Entonces:\n.+\n.+\n.+\n\n¿Empiezo\?/);

    const go = await g.handle('c', 'sí', deps);
    expect(go.kind).toBe('go');
    if (go.kind !== 'go') return;
    expect(go.feature).toBe(false);
    expect(go.text).toContain('Quiero montar una rutina');
    expect(go.text).toContain('sí, pero a las 7:30');
    expect(go.text).toContain('Plan acordado:');
    expect(chat.sent).toHaveLength(2);
    // Cerrada: lo siguiente vuelve a ser conversación normal.
    expect((await g.handle('c', 'gracias', deps)).kind).toBe('pass');
  });

  it('encargo claro: ni preguntas ni llamada al modelo', async () => {
    const g = new GrillMe();
    const chat = fakeChat();
    const model = fakeModel();
    for (const t of ['pon la tele', 'qué tiempo hace', 'recuérdame a las 9 sacar la basura']) {
      expect((await g.handle('c', t, { llm: model.llm, reply: chat.reply })).kind).toBe('pass');
    }
    expect(chat.sent).toEqual([]);
    expect(model.calls).toEqual([]);
  });

  it('«hazlo ya» en el primer mensaje no pregunta; con la ronda abierta, empieza ya', async () => {
    const g = new GrillMe();
    const chat = fakeChat();
    const model = fakeModel();
    const deps = { llm: model.llm, reply: chat.reply };
    expect(
      (await g.handle('a', 'Organízame la semana con el gimnasio y la compra, hazlo ya', deps))
        .kind,
    ).toBe('pass');
    expect(chat.sent).toEqual([]);

    await g.handle('b', 'Organízame la semana con el gimnasio y la compra', deps);
    const go = await g.handle('b', 'hazlo ya', deps);
    expect(go.kind).toBe('go');
    expect(chat.sent).toHaveLength(1);
  });

  it('pedir una función también se pregunta y vuelve marcada como función', async () => {
    const g = new GrillMe();
    const chat = fakeChat();
    const deps = { llm: fakeModel().llm, reply: chat.reply };
    await g.handle('c', 'aprende a avisarme de la lluvia', deps);
    await g.handle('c', 'sí', deps);
    const go = await g.handle('c', 'vale', deps);
    expect(go.kind === 'go' && go.feature).toBe(true);
  });

  it('«no» cancela, y una orden pequeña en medio no rompe la ronda', async () => {
    const g = new GrillMe();
    const chat = fakeChat();
    const deps = { llm: fakeModel().llm, reply: chat.reply };
    await g.handle('c', 'Planifícame un viaje a Roma en mayo', deps);
    expect((await g.handle('c', 'pon la tele', deps)).kind).toBe('pass');
    expect(g.isPending('c')).toBe(true);
    expect((await g.handle('c', 'no', deps)).kind).toBe('handled');
    expect(chat.sent.at(-1)).toBe(GRILL_DROPPED);
    expect(g.isPending('c')).toBe(false);
  });

  it('sin modelo (o si falla) usa preguntas de reserva y la ronda caduca a los 30 min', async () => {
    const g = new GrillMe();
    const chat = fakeChat();
    let now = 0;
    const deps = {
      llm: async () => {
        throw new Error('sin red');
      },
      reply: chat.reply,
      now: () => now,
    };
    await g.handle('c', 'Organízame la mudanza del mes que viene', deps);
    for (const q of FALLBACK_QUESTIONS) expect(chat.sent[0]).toContain(q);
    now = 31 * 60_000;
    expect((await g.handle('c', 'sí', deps)).kind).toBe('pass');
  });

  it('en el chat: el dueño pasa por la ronda antes que «pedir una función» y el turno normal', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const grill = cli.indexOf('await grillMe.handle(chatKey_, inbound.text');
    expect(grill).toBeGreaterThan(0);
    expect(grill).toBeLessThan(cli.indexOf('await handleFeatureAsk(chatKey_'));
    expect(cli.slice(grill - 200, grill)).toContain('isOwnerDm(inbound, vigilanteOwnerId)');
  });
});

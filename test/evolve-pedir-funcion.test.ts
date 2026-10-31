import { describe, expect, it } from 'vitest';
import {
  ASK_CONFIRM,
  ASK_DROPPED,
  ASK_QUEUED,
  ASK_QUEUED_BUSY,
  detectFeatureRequest,
  handleFeatureAsk,
} from '../src/evolve/ask.js';

describe('pedirle una función hablando', () => {
  it.each([
    'Añádete que me avises de la lluvia',
    'mejórate para leer mejor los PDFs',
    'Quiero que sepas hacer resúmenes de mis correos',
    'aprende a poner la radio por las mañanas',
    'Oye, aprende a contarme chistes malos.',
  ])('«%s» es una petición', (t) => {
    expect(detectFeatureRequest(t)?.kind).toBe('queue');
  });

  it.each([
    '¿podrías aprender a avisarme de la lluvia?',
    'puedes añadirte que me leas el tiempo',
    'aprende a hacer café?',
  ])('«%s» pide confirmar', (t) => {
    expect(detectFeatureRequest(t)?.kind).toBe('confirm');
  });

  it.each([
    'si aprendieras a cocinar sería genial',
    'cuando aprendas a conducir me avisas',
    'no aprendas a mentir',
    'aprende',
    'qué tiempo hace mañana',
    'mi hijo aprende a nadar los martes',
    '/evolucion idea algo',
  ])('«%s» no es una petición', (t) => {
    expect(detectFeatureRequest(t)).toBeNull();
  });
});

function deps(over: Partial<Parameters<typeof handleFeatureAsk>[2]> = {}) {
  const ideas: string[] = [];
  const replies: string[] = [];
  let starts = 0;
  const d = {
    isOwner: true,
    addHypothesis: (i: string) => ideas.push(i),
    busy: () => false,
    start: () => {
      starts++;
    },
    reply: async (t: string) => {
      replies.push(t);
    },
    pending: new Map<string, { idea: string; at: number }>(),
    now: () => 1000,
    ...over,
  };
  return { d, ideas, replies, starts: () => starts };
}

describe('lo que hace con la petición', () => {
  it('el dueño: la apunta, contesta una línea y lanza el intento', async () => {
    const t = deps();
    expect(await handleFeatureAsk('k', 'aprende a avisarme de la lluvia', t.d)).toBe(true);
    expect(t.ideas).toEqual(['Petición del dueño: aprende a avisarme de la lluvia']);
    expect(t.replies).toEqual([ASK_QUEUED]);
    expect(t.starts()).toBe(1);
  });

  it('si ya hay una mejora en marcha, lo dice', async () => {
    const t = deps({ busy: () => true });
    await handleFeatureAsk('k', 'aprende a avisarme de la lluvia', t.d);
    expect(t.replies).toEqual([ASK_QUEUED_BUSY]);
  });

  it('otra persona o un grupo: no hace nada y sigue al modelo', async () => {
    const t = deps({ isOwner: false });
    expect(await handleFeatureAsk('k', 'aprende a avisarme de la lluvia', t.d)).toBe(false);
    expect(t.ideas).toEqual([]);
    expect(t.replies).toEqual([]);
  });

  it('una pregunta pide confirmar; «sí» la apunta, «no» la descarta', async () => {
    const t = deps();
    await handleFeatureAsk('k', '¿podrías aprender a avisarme de la lluvia?', t.d);
    expect(t.replies).toEqual([ASK_CONFIRM]);
    expect(t.ideas).toEqual([]);
    expect(await handleFeatureAsk('k', 'sí', t.d)).toBe(true);
    expect(t.ideas).toEqual(['Petición del dueño: podrías aprender a avisarme de la lluvia']);
    const u = deps();
    await handleFeatureAsk('k', '¿podrías aprender a cantar?', u.d);
    expect(await handleFeatureAsk('k', 'no', u.d)).toBe(true);
    expect(u.replies.at(-1)).toBe(ASK_DROPPED);
    expect(u.ideas).toEqual([]);
  });

  it('un «sí» pasado el rato, o sin pregunta antes, no apunta nada', async () => {
    let now = 1000;
    const t = deps({ now: () => now });
    await handleFeatureAsk('k', '¿podrías aprender a cantar?', t.d);
    now += 11 * 60_000;
    expect(await handleFeatureAsk('k', 'sí', t.d)).toBe(false);
    expect(await handleFeatureAsk('otro', 'sí', t.d)).toBe(false);
    expect(t.ideas).toEqual([]);
  });
});

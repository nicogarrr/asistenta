import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { detectFeatureRequest } from '../src/evolve/ask.js';
import {
  EVOLVE_HOW,
  evolveNowAnswer,
  PRICE_WATCH_REMOVE_HINT,
  stopWatchingWords,
} from '../src/palabras-vigilancia.js';
import { watchFromAnswer } from '../src/watch/pages.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const cli = src('cli.ts');

describe('vigilancia de precio y /evolucion sin comandos', () => {
  it('al crear una vigilancia de precio no manda a /vigilando ni /dejar_de_vigilar', () => {
    const pw = src('tools/price-watch.ts');
    expect(pw).not.toContain('/vigilando la lista');
    expect(pw).not.toContain('/dejar_de_vigilar $');
    expect(pw).toContain('{PRICE_WATCH_REMOVE_HINT}');
    expect(PRICE_WATCH_REMOVE_HINT).not.toMatch(/\/\w/);
  });

  it('«deja de vigilar …» se entiende sin comando', () => {
    expect(stopWatchingWords('deja de vigilar')).toBe('');
    expect(stopWatchingWords('Deja de vigilar la tele.')).toBe('tele');
    expect(stopWatchingWords('para de vigilar el iPhone')).toBe('iPhone');
    expect(stopWatchingWords('ya no vigiles la tele')).toBe('tele');
    for (const t of ['vigila la tele', 'deja de mirar', 'no dejes de vigilar la tele', ''])
      expect(stopWatchingWords(t), t).toBeNull();
    const list = [
      { id: 'a1', label: 'Tele LG', url: 'https://tienda.example/tele' },
      { id: 'b2', label: 'iPhone 16', url: 'https://tienda.example/iphone' },
    ];
    expect(watchFromAnswer(list, stopWatchingWords('deja de vigilar la tele') ?? '')?.id).toBe(
      'a1',
    );
    expect(cli).toContain('if (await stopWatchingByWords(inbound)) return;');
  });

  it('el estado de /evolucion no enseña comandos y «prueba ahora» lanza el ciclo', () => {
    expect(src('evolve/run.ts')).not.toContain('añade una idea; /evolucion ahora lanza un ciclo');
    expect(detectFeatureRequest('aprende a resumir mis correos')).not.toBeNull();
    expect(EVOLVE_HOW).not.toMatch(/\/\w|<\w/);
    for (const t of ['prueba ahora', 'Pruébalo ya!', 'lánzalo ahora'])
      expect(evolveNowAnswer(t), t).toBe(true);
    for (const t of ['ahora no', 'prueba', 'sí']) expect(evolveNowAnswer(t), t).toBe(false);
    const p = new PreguntasPendientes();
    p.ask('c', 'evolucion', { answer: (t) => (evolveNowAnswer(t) ? 'ahora' : null) });
    expect(p.consume('c', 'prueba ahora')).toEqual({ name: 'evolucion', args: 'ahora' });
    expect(cli).toContain("preguntas.ask(chatKey(inbound), 'evolucion', {");
  });
});

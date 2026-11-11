import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { altavozWords } from '../src/audio/altavoz.js';
import { isMoreRequest } from '../src/channels/telegram-shared.js';
import { sinMencionDelBot } from '../src/daemon/inbound.js';
import { stopWatchingWords } from '../src/palabras-vigilancia.js';
import { wantsRepitch } from '../src/skills/wait-what.js';

// bugs-36 (lead de bugs-35): en un grupo el bot solo atiende si lo mencionan y la mención
// llega dentro del texto. Los atajos sin modelo comparan la frase entera, así que en un grupo
// «@asistenta_bot deja de vigilar», «@asistenta_bot más» o «@asistenta_bot pon el modo
// altavoz» no saltaban, y «deja de vigilar @asistenta_bot» buscaba una vigilancia llamada
// «@asistenta_bot». #2341 lo arregló solo para «pregúntame antes de…».

describe('sinMencionDelBot', () => {
  it('quita la mención de un bot al principio o al final', () => {
    expect(sinMencionDelBot('@asistenta_bot deja de vigilar')).toBe('deja de vigilar');
    expect(sinMencionDelBot('@Asistenta_Bot, más')).toBe('más');
    expect(sinMencionDelBot('deja de vigilar @asistenta_bot')).toBe('deja de vigilar');
    expect(sinMencionDelBot('¿qué hora es @asistenta_bot?')).toBe('¿qué hora es?');
  });

  it('deja la mención de una persona, la del medio y un texto que sería vacío', () => {
    expect(sinMencionDelBot('@pepe mira esto')).toBe('@pepe mira esto');
    expect(sinMencionDelBot('dile a @asistenta_bot que pare')).toBe(
      'dile a @asistenta_bot que pare',
    );
    expect(sinMencionDelBot('@asistenta_bot')).toBe('@asistenta_bot');
    expect(sinMencionDelBot('@asistenta_bot2 más')).toBe('@asistenta_bot2 más');
  });

  it('con la mención fuera, los atajos de grupo la entienden', () => {
    expect(stopWatchingWords(sinMencionDelBot('@asistenta_bot deja de vigilar'))).toBe('');
    expect(stopWatchingWords(sinMencionDelBot('deja de vigilar @asistenta_bot'))).toBe('');
    expect(isMoreRequest(sinMencionDelBot('@asistenta_bot más'))).toBe(true);
    expect(wantsRepitch(sinMencionDelBot('@asistenta_bot no te entiendo'))).toBe(true);
    expect(altavozWords(sinMencionDelBot('@asistenta_bot pon el modo altavoz'))).toBe('pc');
  });

  it('el daemon la quita a todo mensaje de grupo antes de los atajos', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const start = src.indexOf('onMessage: async (inbound) => {');
    const strip = src.indexOf(
      'if (inbound.isGroup) inbound.text = sinMencionDelBot(inbound.text);',
      start,
    );
    const begin = src.indexOf('beginInbound(inbound', start);
    expect(start).toBeGreaterThan(0);
    expect(strip).toBeGreaterThan(start);
    expect(strip).toBeLessThan(begin);
  });
});

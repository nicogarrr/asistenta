import { describe, expect, it } from 'vitest';
import { foldAccents as dueFold } from '../src/alerts/due.js';
import { wantsScreenshot } from '../src/cli.js';
import { normalizeFactText } from '../src/core/history.js';
import { parseNatural } from '../src/cron/scheduler.js';
import { parsePace } from '../src/notice-pace.js';
import { normalizeText } from '../src/research/deep-research.js';
import { foldAccents } from '../src/text.js';
import { normaliseSpeech } from '../src/voice/conversation.js';

/**
 * Prueba de equivalencia: los helpers que hacían «minúsculas → NFD → quitar marcas»
 * pasan a usar foldAccents (src/text.ts), que hace «NFD → quitar marcas → minúsculas».
 * El orden no cambia nada: se comprueba en TODOS los puntos de código Unicode, solos y
 * en contextos donde JavaScript decide la sigma final griega, y en cadenas mezcladas.
 */
const legacy = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

function* everyCodePoint(): Generator<string> {
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    yield String.fromCodePoint(cp);
  }
}

const contexts = (ch: string): string[] => [
  ch,
  `x${ch}y${ch}`,
  `Σ${ch}`,
  `AΣ${ch}`,
  `${ch}Σ ${ch}`,
];

const CORPUS: string[] = [
  'Árbol Ñandú',
  'ΣΟΦΟΣ ΚΑΙ ΣΟΦΟΣ',
  'ΑΣ́ ΑΣ̈Β ὈΔΥΣΣΕΎΣ',
  'İstanbul KELVIN K Å',
  'ǅungla ﬁ ß ẞ',
  '¿Cómo se ve el PORTÁTIL? Mándame una captura',
  '¿CÓMO ESTÁ EL ORDENADOR?',
  'Enséñame la PANTALLA del pc',
  'Cada día a las 9:30 recuérdame el café',
  'todos los LUNES a las 8 revisa el correo',
  'cada hora mira la web',
  '  Mínimo ',
  'NORMAL',
  'Máximo',
  'estado',
  'Gastó −12,5 € en «Café»',
  '¡Recuérdame MAÑANA a las 7!',
  '',
];

const FROZEN: unknown[] = [
  ['arbol nandu', 'arbol nandu', false, null, null],
  ['σοφος και σοφος', '', false, null, null],
  ['ας ασβ οδυσσευς', '', false, null, null],
  ['istanbul kelvin k a', 'istanbul kelvin k a', false, null, null],
  ['ǆungla ﬁ ß ß', 'ungla', false, null, null],
  [
    '¿como se ve el portatil? mandame una captura',
    'como se ve el portatil mandame una captura',
    true,
    null,
    null,
  ],
  ['¿como esta el ordenador', 'como esta el ordenador', true, null, null],
  ['ensename la pantalla del pc', 'ensename la pantalla del pc', true, null, null],
  [
    'cada dia a las 9:30 recuerdame el cafe',
    'cada dia a las 9 30 recuerdame el cafe',
    false,
    { schedule: '30 9 * * *', prompt: 'Cada día a las 9:30 recuérdame el café' },
    null,
  ],
  [
    'todos los lunes a las 8 revisa el correo',
    'todos los lunes a las 8 revisa el correo',
    false,
    { schedule: '0 8 * * 1', prompt: 'todos los LUNES a las 8 revisa el correo' },
    null,
  ],
  [
    'cada hora mira la web',
    'cada hora mira la web',
    false,
    { schedule: '0 * * * *', prompt: 'cada hora mira la web' },
    null,
  ],
  ['minimo', 'minimo', false, null, 'minimo'],
  ['normal', 'normal', false, null, 'normal'],
  ['maximo', 'maximo', false, null, null],
  ['estado', 'estado', false, null, 'estado'],
  ['gasto -12,5 € en «cafe»', 'gasto 12 5 en cafe', false, null, null],
  [
    '¡recuerdame manana a las 7',
    'recuerdame manana a las 7',
    false,
    { schedule: '0 7 * * *', prompt: '¡Recuérdame MAÑANA a las 7!' },
    null,
  ],
  ['', '', false, null, 'estado'],
];

describe('foldAccents frente a «minúsculas primero»: sin cambio de comportamiento', () => {
  it('foldAccents === versión anterior en todos los puntos de código y contextos', () => {
    const diffs: string[] = [];
    for (const ch of everyCodePoint()) {
      for (const s of contexts(ch)) {
        if (foldAccents(s) !== legacy(s)) {
          diffs.push(ch.codePointAt(0)?.toString(16) ?? '');
          break;
        }
      }
    }
    expect(diffs).toEqual([]);
  });

  it('alerts/due.ts reexporta el foldAccents de src/text.ts', () => {
    expect(dueFold).toBe(foldAccents);
  });

  it('research/deep-research normalizeText es foldAccents en todos los puntos de código', () => {
    const diffs: string[] = [];
    for (const ch of everyCodePoint()) {
      const s = `x${ch}Σ${ch}`;
      if (normalizeText(s) !== legacy(s)) diffs.push(ch.codePointAt(0)?.toString(16) ?? '');
    }
    expect(diffs).toEqual([]);
  });

  it('tabla congelada: cada módulo da lo mismo que en main antes del cambio', () => {
    // Generada con el código de main (minúsculas primero) sobre CORPUS; debe quedar idéntica.
    const got = CORPUS.map((s) => [
      normalizeFactText(s),
      normaliseSpeech(s),
      wantsScreenshot(s),
      parseNatural(s),
      parsePace(s),
    ]);
    expect(got).toEqual(FROZEN);
    for (const s of CORPUS) expect(normalizeText(s)).toBe(legacy(s));
  });

  it('salidas conocidas', () => {
    expect(wantsScreenshot('¿Cómo está el PORTÁTIL?')).toBe(true);
    expect(wantsScreenshot('Mándame una captura')).toBe(true);
    expect(wantsScreenshot('qué tal el día')).toBe(false);
    expect(normaliseSpeech('¡Recuérdame MAÑANA!')).toBe(normaliseSpeech('recuerdame manana'));
  });
});

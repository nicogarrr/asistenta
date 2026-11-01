import { describe, expect, it } from 'vitest';
import { looksLikeCorrection } from '../src/memory/learned-rules.js';

describe('«prefiero» y «a partir de ahora» en frases corrientes no son correcciones', () => {
  it.each([
    'no sé qué prefiero, la verdad',
    '¿cuál prefieres? yo prefiero el azul',
    'prefiero ir mañana al cine',
    'lo que prefiero es quedarme en casa',
    'prefiero la pizza a la pasta',
    'desde ahora hasta el viernes estoy liado',
    'estoy libre desde ahora',
    'a partir de ahora estoy de vacaciones',
    'a partir de ahora no tengo coche',
    'de ahora en adelante trabajo de tarde',
    'mi hermano usa el coche a partir de ahora',
    'a partir de ahora siempre voy en bus',
    'a partir de ahora sin coche, qué pena',
  ])('«%s» no cuenta como corrección', (text) => {
    expect(looksLikeCorrection(text)).toBe(false);
  });
});

describe('las preferencias sobre cómo responde siguen contando', () => {
  it.each([
    'prefiero respuestas cortas',
    'prefiero listas',
    'Prefiero que me respondas en español',
    'prefiero que no uses emojis',
    'preferiría que fueras más breve, prefiero algo más corto',
    'prefiero en inglés',
    'a partir de ahora hazlo así',
    'a partir de ahora respuestas cortas',
    'A partir de ahora, respóndeme en inglés',
    'desde ahora no me mandes audios',
    'de ahora en adelante sin emojis',
    'a partir de ahora quiero que me tutees',
    'contéstame en catalán a partir de ahora',
    'no uses listas desde ahora.',
  ])('«%s» cuenta como corrección', (text) => {
    expect(looksLikeCorrection(text)).toBe(true);
  });
});

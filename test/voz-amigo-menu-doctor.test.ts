import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import { TV_BUTTONS_TITLE } from '../src/tv/tv-chat-command.js';

// Nico (1 nov): «como estamos hablando nosotros». El menú de Telegram, el mando de
// la tele y `pa doctor` enseñaban «/tv apaga la tele», «/learn end», «/tv <orden>»
// y «/ordenador on». Ahora dicen qué decir con palabras.
const desc = (name: string) => TELEGRAM_COMMANDS.find((c) => c.command === name)?.description ?? '';

describe('menú, mando de la tele y pa doctor sin sintaxis de comandos', () => {
  it('el menú de /tv y /learn dice qué decir, sin ejemplos con barra', () => {
    expect(desc('tv')).not.toContain('/tv apaga');
    expect(desc('learn')).toBe('Aprender una rutina mirándote; al acabar dime «ya está»');
    expect(TELEGRAM_COMMANDS).toHaveLength(60);
  });

  it('el mando de la tele no lleva <marcadores>', () => {
    expect(TV_BUTTONS_TITLE).toBe(
      'Mando de la tele (o dime qué hago, por ejemplo «abre Netflix»):',
    );
  });

  it('pa doctor ya no enseña «/ordenador on» ni «/ordenador off»', () => {
    const src = readFileSync('src/preflight.ts', 'utf8');
    for (const viejo of [
      'Actívalo desde Telegram con /ordenador on.',
      'apagado con /ordenador off (guardado',
      'si hay un /ordenador off guardado',
    ]) {
      expect(src).not.toContain(viejo);
    }
  });
});

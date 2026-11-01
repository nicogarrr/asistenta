import { describe, expect, it } from 'vitest';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';

/**
 * Descripciones del menú de Telegram que decían menos de lo que hace el comando:
 * /investiga no mencionaba «amplio» (tabla por elemento, F8) y /tv no decía que sin
 * orden abre el mando con botones (#564). Telegram corta a 256 caracteres.
 */
const desc = (name: string) => TELEGRAM_COMMANDS.find((c) => c.command === name)?.description ?? '';

describe('menú de Telegram: descripciones completas', () => {
  it('/investiga menciona el modo amplio', () => {
    expect(desc('investiga')).toContain('/investiga amplio');
  });

  it('/tv dice que solo abre el mando y sigue dando el ejemplo sin gastar', () => {
    expect(desc('tv')).toContain('/tv solo abre el mando');
    expect(desc('tv')).toContain('dime «apaga la tele»');
    expect(desc('tv')).not.toContain('/tv apaga');
  });

  it('todas caben en el límite de Telegram', () => {
    for (const c of TELEGRAM_COMMANDS) expect(c.description.length).toBeLessThanOrEqual(256);
  });
});

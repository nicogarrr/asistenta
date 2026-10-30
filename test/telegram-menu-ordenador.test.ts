import { describe, expect, it } from 'vitest';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';

/**
 * /ordenador es el interruptor de Computer Use (cu3). Estaba en /help pero no en el
 * menú de Telegram: para cortar el control del PC desde el móvil había que recordar
 * el comando. Ahora sale en el menú y la descripción dice cómo pararlo.
 */
describe('menú de Telegram: /ordenador', () => {
  it('aparece en el menú, una sola vez', () => {
    expect(TELEGRAM_COMMANDS.filter((c) => c.command === 'ordenador')).toHaveLength(1);
  });

  it('la descripción dice que apaga el control del PC y cómo', () => {
    const entry = TELEGRAM_COMMANDS.find((c) => c.command === 'ordenador');
    expect(entry?.description).toMatch(/control del PC/);
    expect(entry?.description).toContain('/ordenador off');
  });
});

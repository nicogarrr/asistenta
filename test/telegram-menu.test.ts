import { describe, expect, it } from 'vitest';
import { configureCommandMenu } from '../src/channels/telegram.js';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import { helpText } from '../src/channels/telegram-help.js';

describe('menú de comandos de Telegram', () => {
  it('lo diario va arriba y /start al final', () => {
    const names = TELEGRAM_COMMANDS.map((c) => c.command);
    expect(names.slice(0, 5)).toEqual(['stop', 'recordatorios', 'agenda', 'pendientes', 'correo']);
    expect(names.at(-1)).toBe('start');
    expect(names.indexOf('help')).toBeLessThan(12);
  });

  it('/correo y /servicios están en el menú y en /help', () => {
    const names = TELEGRAM_COMMANDS.map((c) => c.command);
    expect(names).toContain('correo');
    expect(names).toContain('servicios');
    expect(helpText()).toContain('/correo');
    expect(helpText()).toContain('/servicios');
  });

  it('publica los comandos en ese orden y fija el botón «Menú» a la lista', async () => {
    const calls: string[] = [];
    let published: string[] = [];
    const ok = await configureCommandMenu({
      setMyCommands: async (cmds) => {
        calls.push('setMyCommands');
        published = cmds.map((c) => c.command);
        return true;
      },
      setChatMenuButton: async (opts) => {
        calls.push(`setChatMenuButton:${opts.menu_button.type}`);
        return true;
      },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual(['setMyCommands', 'setChatMenuButton:commands']);
    expect(published).toEqual(TELEGRAM_COMMANDS.map((c) => c.command));
  });

  it('un fallo de Telegram no rompe el arranque', async () => {
    const ok = await configureCommandMenu({
      setMyCommands: async () => {
        throw new Error('429');
      },
      setChatMenuButton: async () => true,
    });
    expect(ok).toBe(false);
  });
});

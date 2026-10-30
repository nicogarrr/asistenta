import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import { HELP_SECTIONS, helpCommands, helpText, startText } from '../src/channels/telegram-help.js';

const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('/help del bot', () => {
  it('documenta cada comando del menú de Telegram (salvo start/help)', () => {
    const documented = new Set(helpCommands());
    const missing = TELEGRAM_COMMANDS.map((c) => c.command).filter(
      (c) => c !== 'start' && c !== 'help' && !documented.has(c),
    );
    expect(missing).toEqual([]);
  });

  it('solo documenta comandos que el despachador atiende', () => {
    for (const command of helpCommands()) {
      expect(cli, `/${command} sale en /help pero no está en commandTable`).toMatch(
        new RegExp(`names: \\[[^\\]]*'${command}'`),
      );
    }
  });

  it('no repite comandos', () => {
    const all = helpCommands();
    expect(new Set(all).size).toBe(all.length);
  });

  it('va por secciones con título y cabe en un mensaje de Telegram', () => {
    const text = helpText();
    for (const section of HELP_SECTIONS) expect(text).toContain(`${section.title}\n/`);
    expect(Array.from(text).length).toBeLessThan(4000);
    expect(text).not.toMatch(/\*\*|__|```/);
  });
});

describe('/start', () => {
  it('saluda por el nombre, da ejemplos y apunta a /help sin el muro de comandos', () => {
    const text = startText('Nico García');
    expect(text.startsWith('¡Hola, Nico!')).toBe(true);
    expect(text).toContain('/help');
    expect(text).toContain('permiso');
    expect(text.split('\n').filter((l) => l.startsWith('/')).length).toBe(0);
    expect(Array.from(text).length).toBeLessThan(600);
  });

  it('sin nombre, saludo neutro', () => {
    expect(startText().startsWith('¡Hola! Soy tu asistente.')).toBe(true);
    expect(startText('   ').startsWith('¡Hola! Soy tu asistente.')).toBe(true);
  });

  it('el despachador responde a /start con la bienvenida y a /help con la ayuda', () => {
    expect(cli).toMatch(/names: \['start'\],\s*run: \(inbound\) => cmdStart\(inbound\)/);
    expect(cli).toMatch(/names: \['help'\],\s*run: \(inbound\) => cmdHelp\(inbound\)/);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import { helpCommands } from '../src/channels/telegram-help.js';

// La tabla de comandos (cli.ts) es la fuente de verdad. /help, el menú de Telegram y la tabla
// no pueden separarse: un comando nuevo sin ayuda, o una ayuda de un comando que ya no existe, falla aquí.
const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const start = src.indexOf('const commandTable = buildCommandTable<Inbound>([');
const end = src.indexOf(']);', start);
/** Cada entrada de la tabla: su nombre principal y sus alias. */
const groups = [...src.slice(start, end).matchAll(/names: \[([^\]]*)\]/g)].map((m) =>
  [...(m[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((n) => n[1] as string),
);
const table = groups.flat();

describe('ayuda y tabla de comandos sin deriva', () => {
  it('la tabla se ha leído', () => {
    expect(start).toBeGreaterThan(0);
    expect(table.length).toBeGreaterThan(50);
  });

  it('todo comando de /help existe en la tabla', () => {
    expect(helpCommands().filter((c) => !table.includes(c))).toEqual([]);
  });

  it('toda entrada de la tabla sale en /help por alguno de sus nombres (salvo ocultas a propósito)', () => {
    const help = new Set(helpCommands());
    const undocumented = groups.filter((g) => !g.some((c) => help.has(c) || c in NOT_IN_HELP));
    expect(undocumented.map((g) => g.join('|'))).toEqual([]);
  });

  it('la lista de ocultos no guarda comandos que ya no existen o que ya tienen ayuda', () => {
    const help = new Set(helpCommands());
    expect(Object.keys(NOT_IN_HELP).filter((c) => !table.includes(c) || help.has(c))).toEqual([]);
  });

  it('todo comando del menú de Telegram sale en /help', () => {
    const help = new Set(helpCommands());
    const menu = TELEGRAM_COMMANDS.map((c) => c.command);
    expect(menu.filter((c) => !help.has(c) && !(c in NOT_IN_HELP))).toEqual([]);
  });
});

/** Comandos de la tabla que no salen en /help, cada uno con su motivo. */
const NOT_IN_HELP: Record<string, string> = {
  help: 'es la propia ayuda',
  start: 'saludo de bienvenida de Telegram; /help ya lo cubre',
};

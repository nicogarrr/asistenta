import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import { helpText } from '../src/channels/telegram-help.js';

describe('Telegram command discovery', () => {
  it('offers every canonical command without duplicates and within Telegram limits', () => {
    expect(TELEGRAM_COMMANDS.length).toBe(60);
    expect(new Set(TELEGRAM_COMMANDS.map((x) => x.command)).size).toBe(TELEGRAM_COMMANDS.length);
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    for (const { command, description } of TELEGRAM_COMMANDS) {
      expect(command).toMatch(/^[a-z_]{1,32}$/);
      expect(description.length).toBeLessThanOrEqual(256);
      expect(cli).toMatch(new RegExp(`names: \\[[^\\]]*'${command}'`));
    }
  });
  it('describes recording and live photos as different operations', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const help = helpText();
    expect(cli).not.toContain('/watch live');
    expect(help).not.toContain('/watch live');
    // /help vive en telegram-help.ts desde que se agrupó por secciones.
    expect(help).toContain('/screen [live|off]');
    expect(help).toMatch(/\/watch \[segundos.*vídeo/);
    expect(TELEGRAM_COMMANDS.find((x) => x.command === 'watch')?.description).toContain('vídeo');
    expect(TELEGRAM_COMMANDS.find((x) => x.command === 'screen')?.description).toContain('foto');
  });
  it('uses Spanish on the private-assistant and legacy approval surfaces', () => {
    const channel = readFileSync(new URL('../src/channels/telegram.ts', import.meta.url), 'utf8');
    expect(channel).not.toContain('This assistant is private.');
    expect(channel).not.toContain("label: 'Approve'");
    expect(channel).not.toContain("label: 'Deny'");
    expect(channel).toContain('Este asistente es privado.');
  });
});

describe('/ocr en el menú', () => {
  it('aparece en el menú de comandos (ya estaba en /help y en el despachador)', () => {
    expect(TELEGRAM_COMMANDS.some((c) => c.command === 'ocr')).toBe(true);
  });
});

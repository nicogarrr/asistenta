import { describe, expect, it } from 'vitest';
import { stripMarks, telegramHtml } from '../src/channels/formatters.js';
import { helpText } from '../src/channels/telegram-help.js';

describe('/help con títulos en negrita', () => {
  it('cada título de sección sale en <b> y el resto del texto no cambia', () => {
    const bold = helpText({ bold: true });
    const html = telegramHtml(bold);
    expect(html).toContain('<b>⚡ Lo básico</b>');
    expect(html).toContain('<b>⏰ Recordatorios y agenda</b>');
    // Solo los títulos llevan marcas: quitadas, es exactamente el /help de siempre.
    expect(stripMarks(bold)).toBe(helpText());
    // Argumentos como <id> o <enlace> siguen escapados, no se toman por HTML.
    expect(html).toContain('&lt;enlace&gt;');
    expect(html).not.toMatch(/<(?!\/?(b|i|code|pre)\b)[a-z]/);
  });

  it('sin la opción no hay marcas (otros usos en texto plano)', () => {
    expect(helpText()).not.toContain('**');
  });

  it('cli.ts envía /help con format marks', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/cli.ts', 'utf8')).toContain(
      "helpText({ bold: true }), { quote: true, format: 'marks' }",
    );
  });
});

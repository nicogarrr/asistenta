import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  escapeMarks,
  isAgendaTitle,
  isReminderTitle,
  marksWithTitles,
  stripMarks,
  telegramHtml,
} from '../src/channels/formatters.js';
import { formatReminderRows } from '../src/tools/reminder.js';

/**
 * /recordatorios y /agenda con títulos en negrita (format marks). El texto de cada
 * recordatorio o cita es del usuario: sus `**` y acentos graves nunca se vuelven formato.
 */
const reminderList = [
  'Recordatorios: 2',
  '1. llamar al **dentista** — mañana 9:00 (en 18 h)',
  '2. revisar `npm` y ``` — 3 nov (en 4 días) · se repite (0 9 * * 1)',
  '',
  'Para borrar uno: /recordatorios borrar <número o palabra>',
].join('\n');

const agendaText = [
  'Hoy',
  '- 10:00  **Reunión** con <Ana> & co',
  'Mañana, sábado 31 oct',
  '- todo el día  Cumple',
  'Esta semana',
  'lunes 2 nov',
  '- 9:00  Dentista',
  'Pendientes',
  '- Hoy (texto de un recordatorio que se llama así)',
  '',
  'Rutinas programadas: 1',
  '- resumen [0 8 * * *] — próxima: mañana 8:00',
  '',
  'Objetivos abiertos',
  '- Pintar la `casa` (activo)',
].join('\n');

describe('títulos en negrita con texto del usuario literal', () => {
  it('/recordatorios: el título va en negrita y los ** del usuario no', () => {
    const html = telegramHtml(marksWithTitles(reminderList, isReminderTitle));
    expect(html.split('\n')[0]).toBe('<b>Recordatorios: 2</b>');
    expect(html).not.toContain('<b>dentista</b>');
    expect(html).not.toContain('<code>');
    expect(html).not.toContain('<pre>');
    expect(html).toContain('&lt;número o palabra&gt;');
    // Sin formato (Telegram rechaza el HTML) se ve igual que antes.
    const plain = stripMarks(marksWithTitles(reminderList, isReminderTitle));
    expect(plain.replace(/\u2060/g, '').replace(/\u02CB/g, '`')).toBe(reminderList);
  });

  it('formatReminderRows real: el título que produce es el que se pone en negrita', () => {
    const text = formatReminderRows([]);
    expect(marksWithTitles(text, isReminderTitle)).toBe(escapeMarks(text));
    expect(isReminderTitle('Recordatorios: 12')).toBe(true);
    expect(isReminderTitle('1. Recordatorios: 12')).toBe(false);
  });

  it('/agenda: secciones en negrita, viñetas (texto del calendario) nunca', () => {
    const html = telegramHtml(marksWithTitles(agendaText, isAgendaTitle)).split('\n');
    for (const t of [
      'Hoy',
      'Mañana, sábado 31 oct',
      'Esta semana',
      'Pendientes',
      'Rutinas programadas: 1',
      'Objetivos abiertos',
    ]) {
      expect(html).toContain(`<b>${t}</b>`);
    }
    expect(html).toContain(
      '- 10:00  **Reunión** con &lt;Ana&gt; &amp; co'
        .replace('**', '*\u2060*')
        .replace('**', '*\u2060*'),
    );
    expect(html.join('\n')).not.toContain('<code>');
    expect(html).toContain('lunes 2 nov');
    expect(html).toContain('- Hoy (texto de un recordatorio que se llama así)');
  });

  it('escapeMarks neutraliza negrita, código y vallas', () => {
    expect(telegramHtml(escapeMarks('**a** `b` ```'))).toBe(
      '*\u2060*a*\u2060* \u02CBb\u02CB \u02CB\u02CB\u02CB',
    );
  });

  it('cli.ts envía /recordatorios y /agenda con formato marks y títulos', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(
      /marksWithTitles\(formatReminderRows\(rows\(\)\), isReminderTitle\)[\s\S]{0,80}format: 'marks'/,
    );
    expect(cli).toMatch(
      /marksWithTitles\(text, isAgendaTitle\), \{ quote: true, format: 'marks' \}/,
    );
  });
});

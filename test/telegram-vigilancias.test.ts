import { describe, expect, it } from 'vitest';
import { telegramHtml } from '../src/channels/formatters.js';
import { commandFromCallback } from '../src/channels/telegram.js';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import { vigilanciasReply } from '../src/cli.js';
import { forChat, isOverviewTitle, type OverviewEntry } from '../src/watch/overview.js';

/** /vigilancias en Telegram: la vista única (antes solo `pa vigilancias`), con cabeceras en negrita y «📈 Precio …» de solo lectura. */
const e = (over: Partial<OverviewEntry>): OverviewEntry =>
  ({
    kind: 'pagina',
    id: 'a1b2',
    label: 'Zapatillas',
    target: 'https://t.example/p',
    scope: '42',
    enabled: true,
    ...over,
  }) as OverviewEntry;

const entries: OverviewEntry[] = [
  e({}),
  e({ id: 'zz99', label: 'De otro chat', scope: '77' }),
  e({
    kind: 'rutina',
    id: 'r1',
    label: 'resumen',
    target: '0 8 * * *',
    scope: 'telegram:dm:42#viaje',
  }),
  e({ kind: 'rutina', id: 'r2', label: 'ajena', target: '0 9 * * *', scope: 'telegram:dm:77' }),
  e({ kind: 'rutina', id: 'r3', label: 'whats', target: '0 9 * * *', scope: 'whatsapp:dm:42' }),
  e({ kind: 'ojo', id: 'general', label: 'Ojo general', target: '', scope: '' }),
];

describe('/vigilancias en Telegram', () => {
  it('está en el menú de Telegram', () => {
    expect(TELEGRAM_COMMANDS.some((c) => c.command === 'vigilancias')).toBe(true);
  });

  it('forChat: solo lo de este chat de Telegram y lo global', () => {
    const ids = forChat(entries, '42', 'telegram').map((x) => x.id);
    expect(ids).toEqual(['a1b2', 'r1', 'general']);
  });

  it('isOverviewTitle: cabecera general y de cada grupo, nada más', () => {
    expect(isOverviewTitle('Vigilancias: 3 (3 activas)')).toBe(true);
    expect(isOverviewTitle('Páginas vigiladas (1)')).toBe(true);
    expect(isOverviewTitle('Rutinas programadas (2)')).toBe(true);
    expect(isOverviewTitle('• Páginas vigiladas (1)')).toBe(false);
    expect(isOverviewTitle('Zapatillas (1)')).toBe(false);
  });

  it('respuesta: cabeceras en <b>, texto del usuario escapado, sin cosas de otros chats', () => {
    const r = vigilanciasReply(
      [...entries, e({ id: 'c3d4', label: '**Oferta** <x>', scope: '42' })],
      '42',
    );
    const html = telegramHtml(r.text);
    expect(html).toContain('<b>Vigilancias: 4 (4 activas)</b>');
    expect(html).toContain('<b>Páginas vigiladas (2)</b>');
    expect(html).toContain('<b>Rutinas programadas (1)</b>');
    expect(html).not.toContain('<b>Oferta</b>');
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('De otro chat');
    expect(html).not.toContain('ajena');
  });

  it('botones: «📈 Precio …» por página de este chat, solo lectura (/precio <id>)', () => {
    const r = vigilanciasReply(entries, '42');
    expect(r.buttons?.map((b) => b.label)).toEqual(['📈 Precio Zapatillas']);
    expect(r.buttons?.map((b) => commandFromCallback(b.action))).toEqual(['/precio a1b2']);
  });

  it('sin páginas: sin botones; vacío: frase clara', () => {
    expect(vigilanciasReply([entries[2] as OverviewEntry], '42').buttons).toBeUndefined();
    const empty = vigilanciasReply([], '42');
    expect(empty.text).toBe('No hay ninguna vigilancia activa.');
    expect(empty.buttons).toBeUndefined();
  });

  it('como mucho 8 botones', () => {
    const many = Array.from({ length: 12 }, (_, i) => e({ id: `p${i}`, label: `P${i}` }));
    expect(vigilanciasReply(many, '42').buttons).toHaveLength(8);
  });
});

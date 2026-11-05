import { describe, expect, it, vi } from 'vitest';
import { answerBtw, btwContext, btwFromText, btwUserPrompt } from '../src/btw.js';
import { TELEGRAM_COMMANDS } from '../src/channels/telegram-commands.js';
import { HELP_SECTIONS } from '../src/channels/telegram-help.js';

describe('/btw: pregunta al margen mientras una tarea sigue', () => {
  it('contesta con el modelo, sin herramientas, y dice que lo otro sigue', async () => {
    const llm = vi.fn(async () => 'En Tokio son las 18:30.');
    const out = await answerBtw('¿qué hora es en Tokio?', {
      llm,
      busy: true,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Ordena mis fotos de 2024 por meses' }] },
        { role: 'assistant', content: [{ type: 'toolCall', name: 'fs' }] },
        { role: 'toolResult', content: [{ type: 'text', text: 'SECRETO de herramienta' }] },
      ],
      now: new Date('2026-11-05T09:30:00Z'),
      timeZone: 'Europe/Madrid',
    });
    expect(out).toBe('💬 En Tokio son las 18:30.\n\n(Sigo con lo otro.)');
    const [system, user, max] = llm.mock.calls[0] as unknown as [string, string, number];
    expect(system).toMatch(/No tienes herramientas/);
    expect(system).toMatch(/otra tarea que sigue en marcha/);
    expect(system).toMatch(/2026/);
    expect(user).toContain('Dueño: Ordena mis fotos de 2024 por meses');
    expect(user).not.toContain('SECRETO');
    expect(user).toContain('Pregunta al margen: ¿qué hora es en Tokio?');
    expect(max).toBeLessThanOrEqual(600);
  });

  it('sin nada en marcha no añade «sigo con lo otro»', async () => {
    const out = await answerBtw('¿capital de Australia?', {
      llm: async () => 'Canberra.',
      busy: false,
    });
    expect(out).toBe('💬 Canberra.');
  });

  it('nunca lanza: sin modelo o con error lo explica', async () => {
    expect(await answerBtw('¿hola?', { llm: undefined, busy: true })).toMatch(
      /no tengo modelo.*sigue en marcha/,
    );
    const failing = async (): Promise<string> => {
      throw new Error('429');
    };
    expect(await answerBtw('¿hola?', { llm: failing, busy: true })).toMatch(
      /No he podido contestarte al margen.*sigue en marcha/,
    );
    expect(await answerBtw('   ', { llm: failing, busy: false })).toMatch(/^Uso: \/btw/);
  });

  it('«btw …?» escrito solo cuenta si es una pregunta', () => {
    expect(btwFromText('btw ¿qué hora es en Tokio?')).toBe('¿qué hora es en Tokio?');
    expect(btwFromText('BTW, cuánto es 15% de 80?')).toBe('cuánto es 15% de 80?');
    expect(btwFromText('btw usa el otro fichero')).toBeNull();
    expect(btwFromText('¿qué hora es?')).toBeNull();
    expect(btwFromText(undefined)).toBeNull();
  });

  it('el contexto va de lo más reciente hacia atrás y con tope', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `mensaje número ${i} ${'x'.repeat(80)}`,
    }));
    const ctx = btwContext(msgs, 400);
    expect(ctx.length).toBeLessThanOrEqual(420);
    expect(ctx).toContain('mensaje número 49');
    expect(ctx).not.toContain('mensaje número 10 ');
    expect(btwUserPrompt('¿y?', '')).toBe('Pregunta al margen: ¿y?');
  });

  it('sale en /help y en el menú de Telegram', () => {
    expect(HELP_SECTIONS.flatMap((s) => s.entries).some((e) => e.command === 'btw')).toBe(true);
    expect(TELEGRAM_COMMANDS.some((c) => c.command === 'btw')).toBe(true);
  });
});

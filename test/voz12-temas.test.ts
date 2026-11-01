import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { backToMainAnswer, topicReadyText } from '../src/temas.js';

// Nico (1 nov): que Asistenta hable como un amigo, sin mandarle a comandos.
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

describe('/topic sin mandar a «/topic main»', () => {
  it('al abrir otra conversación dice cómo volver en palabras', () => {
    expect(topicReadyText('viaje')).toBe(
      'Conversación "viaje" lista. Lo que escribas va aquí; cuando quieras volver a la principal, dime «vuelve a la principal».',
    );
    expect(topicReadyText('main')).toBe('De vuelta en la conversación principal.');
    expect(cli).not.toContain('/topic main vuelve a la principal');
  });

  it('«vuelve a la principal» vuelve, solo con otra conversación activa', () => {
    for (const t of [
      'vuelve a la principal',
      'Volvamos a la conversación principal.',
      'pásate a la principal',
    ]) {
      expect(backToMainAnswer(t), t).toBe(true);
    }
    for (const t of ['vuelve a la página principal', 'la principal', 'vuelve']) {
      expect(backToMainAnswer(t), t).toBe(false);
    }
    expect(cli).toContain(
      "if (!current || current === 'main' || !backToMainAnswer(inbound.text)) return false;",
    );
    expect(cli).toContain('if (await backToMainByWords(inbound)) return;');
  });
});

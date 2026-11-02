import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { specialistNote, withSpecialistNote } from '../src/daemon/panel-chat.js';

/**
 * Telegram también dice qué especialista hizo la tarea (asis-expertos-3), con la misma
 * línea que el panel («🧩 Lo hizo el especialista Tele.») al final de la respuesta,
 * como las otras líneas de pie («📝 Aprendido: …»). Sin especialista, la respuesta no
 * cambia; el panel sigue añadiéndola él solo (no sale dos veces). Ni comandos ni /help.
 */
describe('withSpecialistNote', () => {
  it('añade la línea del especialista al final', () => {
    expect(withSpecialistNote('Tele apagada.', ['tv'])).toBe(
      'Tele apagada.\n\n🧩 Lo hizo el especialista Tele.',
    );
    expect(withSpecialistNote('Hecho.', ['tv', 'correo', 'tv'])).toBe(
      `Hecho.\n\n${specialistNote(['tv', 'correo'])}`,
    );
  });

  it('sin especialista (o con uno desconocido) la respuesta queda igual', () => {
    expect(withSpecialistNote('Hola.', [])).toBe('Hola.');
    expect(withSpecialistNote('Hola.', ['banco'])).toBe('Hola.');
  });

  it('no la repite si ya está', () => {
    const once = withSpecialistNote('Hecho.', ['hogar']);
    expect(withSpecialistNote(once, ['hogar'])).toBe(once);
  });
});

describe('cableado en cli.ts', () => {
  const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

  it('el turno de Telegram junta los especialistas y añade la línea; el panel, como antes', () => {
    expect(source).toContain('if (out) out.specialist?.(info.specialist);');
    expect(source).toContain('else specialistsUsed.push(info.specialist);');
    expect(source).toContain(
      "if (!out && inbound.channel === 'telegram' && result.error === null)",
    );
    expect(source).toContain('withSpecialistNote(result.text, specialistsUsed)');
  });
});

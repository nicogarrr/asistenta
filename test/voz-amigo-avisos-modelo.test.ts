import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatModelos, parseModelo } from '../src/model-choice.js';
import { formatRules } from '../src/ojo-ignore.js';
import { AVISAR_OTRA_VEZ, describeWatch } from '../src/watch/pages.js';

// Nico (1 nov): «como estamos hablando nosotros». Seguían saliendo «/vigila avisar
// ID para quitarlo», «Dime /ignorados activar 3», «/ignora <número>» y «Cambia con
// /modelo <número|nombre>». Ahora se dice normal y la respuesta suelta vale.
const cli = readFileSync('src/cli.ts', 'utf8');

describe('avisos, ignorados y modelo sin comandos', () => {
  it('una vigilancia silenciada dice cómo quitarlo con palabras', () => {
    const now = Date.UTC(2026, 10, 1, 10, 0);
    const w = {
      id: 'abc123',
      chatId: '42',
      url: 'https://example.com/tele',
      label: 'Tele',
      keyword: '',
      lastValue: '',
      lastCheckedAt: 0,
      targetCents: null,
      dropPct: null,
      mutedUntil: now + 3_600_000,
      createdAt: now,
    };
    // biome-ignore lint/suspicious/noExplicitAny: solo los campos que lee describeWatch.
    const text = describeWatch(w as any, null, now);
    expect(text).toContain('🔕 Silenciada hasta');
    expect(text).toContain('dime «avísame otra vez»');
    expect(text).not.toMatch(/\/vigila|\(\//);
    for (const t of ['avísame otra vez', 'Avisame', 'sí, avísame ya', 'quítale el silencio'])
      expect(AVISAR_OTRA_VEZ.test(t), t).toBe(true);
    for (const t of ['avísame si baja de 300', 'no', 'quita la vigilancia'])
      expect(AVISAR_OTRA_VEZ.test(t), t).toBe(false);
    expect(cli).toContain('answer: (t) => (AVISAR_OTRA_VEZ.test(t.trim()) ? `avisar ');
  });

  it('proponer una regla de ignorar pregunta «sí» y no enseña /ignorados', () => {
    expect(cli).not.toContain('Dime /ignorados activar');
    expect(cli).toContain('¿Dejo de avisarte de esa clase? Dime «sí».`');
    expect(cli).toContain('answer: (t) => (SI_RESPUESTA.test(t) ? `activar ');
    expect(formatRules([])).toBe(
      'No hay reglas de ignorar. Cuando descartes dos avisos parecidos, te propongo una.',
    );
  });

  it('el modelo se elige diciendo el número o el nombre', () => {
    const models = ['gpt-a', 'claude-b'];
    const list = formatModelos(models, 'gpt-a');
    expect(list).toContain(
      '¿Cuál quieres? Dime su número o su nombre, o «normal» para volver al principal.',
    );
    expect(list).not.toMatch(/\/modelo|<[a-z]/);
    for (const r of [parseModelo('7', models), parseModelo('llama', models)]) {
      expect(r.kind).toBe('error');
      if (r.kind === 'error') expect(r.text).not.toContain('/modelo');
    }
    expect(parseModelo('7', models)).toEqual({
      kind: 'error',
      text: 'No hay modelo 7: tengo del 1 al 2.',
    });
    expect(cli).toContain("preguntas.ask(chatKey(inbound), 'modelo', {");
  });
});

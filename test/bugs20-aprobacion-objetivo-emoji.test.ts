import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import { formatGoalMessage } from '../src/goals/notify.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// asis-bugs-20: la pregunta de aprobación del navegador recorta el contexto del
// elemento (300) y el resumen de la página (700), y los avisos de un objetivo recortan
// su motivo (600), con slice a ciegas; un emoji en el corte llegaba a Telegram como «�».
describe('aprobación del navegador y avisos de objetivos: sin medio emoji', () => {
  it('contexto y resumen de la página largos', () => {
    const target = [
      'button | Comprar',
      '\nCONTEXTO DEL ELEMENTO:\n',
      `${'c'.repeat(299)}🛒 carrito`,
      '\nRESUMEN DE LA PÁGINA:\n',
      `${'s'.repeat(699)}🛒 oferta`,
    ].join('');
    const a = formatApproval(
      { tool: 'browser', args: { _target: target }, actor: 'asistenta' },
      'r',
    );
    expect(a.question).toContain(`Parte de: ${'c'.repeat(299)}\n`);
    expect(a.question).toContain(`${'s'.repeat(699)}\n`);
    expect(a.question).not.toMatch(LONE);
  });

  it('elemento largo', () => {
    const a = formatApproval(
      {
        tool: 'browser',
        args: { _target: `button | ${'e'.repeat(290)}🛒 comprar ya` },
        actor: 'asistenta',
      },
      'r',
    );
    expect(a.question).not.toMatch(LONE);
  });

  it('aviso de un objetivo con motivo largo', () => {
    const text = formatGoalMessage('hito', { title: 'T' }, `${'h'.repeat(599)}🎉 listo`);
    expect(text).toBe(`🎯 T: ${'h'.repeat(599)}`);
  });
});

import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';

/**
 * Un type con `secret: "true"` o `secret: 1` (posible en un elemento de lote, que
 * no pasa por el esquema) no se trataba como secreto: la pregunta de aprobación
 * enseñaba el texto en el chat. Ahora cualquier valor que no sea un «no»
 * explícito cuenta como secreto y la acción queda denegada sin mostrarlo.
 */
const call = (args: Record<string, unknown>) => ({ tool: 'computer', args, actor: 'test' });

describe('approval: secret no literal también es secreto', () => {
  it('type suelto con secret "true", 1 o "sí" se deniega sin enseñar el texto', () => {
    for (const secret of ['true', 1, 'sí', 'TRUE', 'yes']) {
      const t = formatApproval(call({ action: 'type', text: 'gatito77', secret }), 'r');
      expect(t.complete, String(secret)).toBe(false);
      expect(t.question).toContain('secret: true');
      expect(t.question).not.toContain('gatito77');
    }
  });

  it('en un lote, un type con secret "true" deniega el lote entero', () => {
    const t = formatApproval(
      call({
        action: 'batch',
        actions: [
          { action: 'click', x: 1, y: 1 },
          { action: 'type', text: 'gatito77', secret: 'true' },
        ],
      }),
      'r',
    );
    expect(t.complete).toBe(false);
    expect(t.question).not.toContain('gatito77');
  });

  it('sin secret, o con un no explícito, la pregunta es la de siempre', () => {
    for (const secret of [undefined, false, 'false', 0, 'no', '']) {
      const t = formatApproval(call({ action: 'type', text: 'hola', secret }), 'r');
      expect(t.question, String(secret)).not.toContain('secret: true');
    }
  });
});

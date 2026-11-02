import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { renderForSummary } from '../src/core/history.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

// asis-bugs-18: el texto que se manda al modelo para resumir la conversación cortaba a
// ciegas los argumentos de una herramienta (300) y su resultado (400); con un emoji en
// el corte quedaba medio carácter, y el proveedor puede rechazar el resumen entero.
describe('resumen de la conversación sin medio emoji', () => {
  it('argumentos y resultado de una herramienta largos', () => {
    const args = { texto: `${'a'.repeat(300 - '{"texto":"'.length - 1)}🎂 y más` };
    const t = renderForSummary([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c', name: 'nota', arguments: args }],
      } as unknown as AgentMessage,
      {
        role: 'toolResult',
        toolCallId: 'c',
        toolName: 'nota',
        content: [{ type: 'text', text: `${'r'.repeat(399)}🎉${'z'.repeat(50)}` }],
        isError: false,
      } as unknown as AgentMessage,
    ]);
    expect(t).toContain('[llamada nota:');
    expect(t).toContain('caracteres omitidos');
    expect(t).not.toMatch(LONE);
  });
});

import { describe, expect, it } from 'vitest';
import { formatApprovalQuestion } from '../src/approval-text.js';
import { readMcpHttpServers } from '../src/mcp/http-client.js';

/**
 * Cortes a ciegas (`slice`) que podían partir un emoji: medio par sustituto deja el texto mal
 * formado; Telegram lo enseña como «�» o rechaza el mensaje, y la pregunta de aprobación de
 * escribir una nota con emojis podía no llegar.
 */
const wellFormed = (t: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);

describe('cortes sin partir emojis', () => {
  it('la vista previa de escribir un archivo no deja medio emoji', () => {
    const content = `${'a'.repeat(1199)}😀 y más texto ${'b'.repeat(200)}`;
    const q = formatApprovalQuestion(
      { tool: 'write', args: { path: 'C:/notas/plan.md', content }, actor: 'asistenta' },
      'guardar la nota',
    );
    expect(q).toContain('caracteres en total');
    expect(wellFormed(q)).toBe(true);
    expect(q).toContain('a'.repeat(1199));
  });

  it('la vista previa de editar tampoco', () => {
    const q = formatApprovalQuestion(
      {
        tool: 'edit',
        args: { path: 'nota.md', oldString: 'x', newString: `${'c'.repeat(1193)}🎉🎉🎉` },
        actor: 'asistenta',
      },
      'editar',
    );
    expect(wellFormed(q)).toBe(true);
  });

  it('el nombre mostrado de un servidor MCP saltado no parte un emoji', () => {
    const name = `${'s'.repeat(39)}🚀resto`;
    const report = readMcpHttpServers(JSON.stringify([{ name, url: 'https://ejemplo.com/mcp' }]));
    expect(report.skipped).toHaveLength(1);
    expect(wellFormed(report.skipped[0]?.name ?? '')).toBe(true);
    expect(report.skipped[0]?.name).toBe('s'.repeat(39));
  });
});

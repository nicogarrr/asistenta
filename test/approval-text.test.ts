import { describe, expect, it } from 'vitest';
import { formatApprovalQuestion } from '../src/approval-text.js';
import type { ToolCall } from '../src/permissions.js';

function call(tool: string, args: Record<string, unknown>): ToolCall {
  return { tool, args, actor: 'local' } as ToolCall;
}

describe('formatApprovalQuestion', () => {
  it('shell muestra el comando que se va a aprobar', () => {
    const q = formatApprovalQuestion(call('shell', { command: 'Remove-Item ./tmp -Recurse' }), 'riesgo: borrado');
    expect(q).toContain('¿Permito ejecutar este comando?');
    expect(q).toContain('Remove-Item ./tmp -Recurse');
    expect(q).toContain('Motivo: riesgo: borrado');
  });

  it('shell trunca comandos muy largos', () => {
    const q = formatApprovalQuestion(call('shell', { command: 'x'.repeat(2000) }), 'r');
    const body = q.split('Comando:\n')[1].split('\nMotivo:')[0];
    expect(body.length).toBe(700);
  });

  it('shell sin command no rompe ni inventa', () => {
    const q = formatApprovalQuestion(call('shell', {}), 'r');
    expect(q).toContain('¿Permito ejecutar este comando?');
    expect(q).not.toContain('Comando:');
  });

  it('computer describe la acción con sus datos', () => {
    expect(formatApprovalQuestion(call('computer', { action: 'click', x: 10, y: 20 }), 'r')).toContain('click en (10, 20)');
    expect(formatApprovalQuestion(call('computer', { action: 'type', text: 'hola' }), 'r')).toContain('escribir "hola"');
    expect(formatApprovalQuestion(call('computer', { action: 'key', key: 'Enter' }), 'r')).toContain('pulsar Enter');
  });

  it('computer batch lista las sub-acciones y resume el resto', () => {
    const actions = [
      { action: 'click', x: 1, y: 2 },
      { action: 'type', text: 'abc' },
      ...Array.from({ length: 10 }, () => ({ action: 'key', key: 'Tab' })),
    ];
    const q = formatApprovalQuestion(call('computer', { action: 'batch', actions }), 'r');
    expect(q).toContain('Lote de 12 acciones:');
    expect(q).toContain('1. click en (1, 2)');
    expect(q).toContain('2. escribir "abc"');
    expect(q).toContain('… y 2 más');
  });

  it('browser con _target mantiene el formato informado', () => {
    const q = formatApprovalQuestion(
      call('browser', { _target: 'Botón Pagar | 11,40 €\nRESUMEN DE LA PÁGINA:\nTotal: 11,40 €' }),
      'pago',
    );
    expect(q).toContain('¿Permito esta acción en el navegador?');
    expect(q).toContain('Botón Pagar');
    expect(q).toContain('Total: 11,40 €');
  });

  it('otras tools conservan el formato genérico', () => {
    expect(formatApprovalQuestion(call('docs', { action: 'create' }), 'escritura')).toBe('¿Permito docs?\nescritura');
  });
});

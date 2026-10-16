import { describe, expect, it } from 'vitest';
import { formatApproval, formatApprovalQuestion, redactSecrets } from '../src/approval-text.js';
import { toolOfQuestion } from '../src/channels/qa.js';
import type { ToolCall } from '../src/permissions.js';

function call(tool: string, args: Record<string, unknown>): ToolCall {
  return { tool, args, actor: 'local' } as ToolCall;
}

describe('formatApproval: shell', () => {
  it('muestra el comando completo y el motivo', () => {
    const a = formatApproval(call('shell', { command: 'Remove-Item ./tmp -Recurse' }), 'riesgo: borrado');
    expect(a.complete).toBe(true);
    expect(a.question).toContain('Remove-Item ./tmp -Recurse');
    expect(a.question).toContain('Motivo: riesgo: borrado');
  });

  it('canario: mismo prefijo, colas distintas → preguntas aprobables siempre distintas', () => {
    // Bajo presupuesto: se muestran ENTEROS, así que difieren.
    const prefix = 'Get-ChildItem ' + 'x'.repeat(1200);
    const safe = formatApproval(call('shell', { command: prefix }), 'r');
    const evil = formatApproval(call('shell', { command: prefix + '; Remove-Item C:\\ -Recurse -Force' }), 'r');
    expect(safe.complete).toBe(true);
    expect(evil.complete).toBe(true);
    expect(safe.question === evil.question).toBe(false);
    // Sobre presupuesto: NINGUNO es aprobable (fail-closed), así que no hay
    // pregunta ambigua que aprobar. La denegada no enseña el comando recortado.
    const longPrefix = 'Get-ChildItem ' + 'x'.repeat(3600);
    const safeLong = formatApproval(call('shell', { command: longPrefix }), 'r');
    const evilLong = formatApproval(call('shell', { command: longPrefix + '; Remove-Item C:\\ -Recurse -Force' }), 'r');
    expect(safeLong.complete).toBe(false);
    expect(evilLong.complete).toBe(false);
    expect(evilLong.question).toContain('DENEGADA');
    expect(evilLong.question).not.toContain('Remove-Item');
    expect(evilLong.question).not.toContain('xxxx');
  });

  it('comando bajo presupuesto pero largo se muestra entero (sin recorte)', () => {
    const cmd = 'Write-Output ' + 'a'.repeat(3000);
    const a = formatApproval(call('shell', { command: cmd }), 'r');
    expect(a.complete).toBe(true);
    expect(a.question).toContain('a'.repeat(3000));
  });
});

describe('formatApproval: computer', () => {
  it('canario: drag con destinos distintos produce preguntas distintas', () => {
    const a = formatApproval(call('computer', { action: 'drag', x: 1, y: 2, toX: 100, toY: 200 }), 'r');
    const b = formatApproval(call('computer', { action: 'drag', x: 1, y: 2, toX: 999, toY: 999 }), 'r');
    expect(a.question).toContain('a (100, 200)');
    expect(b.question).toContain('a (999, 999)');
    expect(a.question === b.question).toBe(false);
  });

  it('canario: click izquierdo vs derecho vs doble vs roi producen preguntas distintas', () => {
    const plain = formatApproval(call('computer', { action: 'click', x: 10, y: 20 }), 'r').question;
    const right = formatApproval(call('computer', { action: 'click', x: 10, y: 20, button: 'right' }), 'r').question;
    const double = formatApproval(call('computer', { action: 'click', x: 10, y: 20, clicks: 2 }), 'r').question;
    const roi = formatApproval(call('computer', { action: 'click', x: 10, y: 20, roi: { x: 0, y: 0, width: 50, height: 50 } }), 'r').question;
    expect(new Set([plain, right, double, roi]).size).toBe(4);
    expect(right).toContain('derecho');
    expect(double).toContain('x2');
    expect(roi).toContain('roi');
  });

  it('batch muestra TODAS las sub-acciones (nada oculto tras "y N más")', () => {
    const actions = Array.from({ length: 12 }, (_, i) => ({ action: 'key', key: `F${i + 1}` }));
    const a = formatApproval(call('computer', { action: 'batch', actions }), 'r');
    expect(a.complete).toBe(true);
    expect(a.question).toContain('Lote de 12 acciones:');
    for (let i = 1; i <= 12; i++) expect(a.question).toContain(`${i}. pulsar F${i}`);
    expect(a.question).not.toContain('… y');
  });

  it('batch que no cabe: fail-closed, sin lista parcial', () => {
    const actions = Array.from({ length: 500 }, () => ({ action: 'type', text: 'x'.repeat(40) }));
    const a = formatApproval(call('computer', { action: 'batch', actions }), 'r');
    expect(a.complete).toBe(false);
    expect(a.question).toContain('DENEGADA');
    expect(a.question).not.toContain('Lote de 500');
  });

  it('parámetros desconocidos se muestran, no se esconden', () => {
    const a = formatApproval(call('computer', { action: 'click', x: 1, y: 2, pressure: 0.9 }), 'r');
    expect(a.question).toContain('pressure: 0.9');
  });
});

describe('redacción de secretos', () => {
  it('enmascara tokens y contraseñas en comandos y texto tecleado', () => {
    const a = formatApproval(
      call('shell', { command: 'curl -H "Authorization: Bearer fakeAuthorizationToken123" --data password=Sup3rSecret! https://x' }),
      'r',
    );
    expect(a.question).not.toContain('fakeAuthorizationToken123');
    expect(a.question).not.toContain('Sup3rSecret!');
    expect(a.question).toContain('[redacted]');

    const b = formatApproval(call('computer', { action: 'type', text: 'mi clave es token=abcd1234efgh' }), 'r');
    expect(b.question).not.toContain('abcd1234efgh');
  });

  it('redactSecrets cubre flags estilo PowerShell y JWTs', () => {
    expect(redactSecrets('Run -Password "Sup3rSecret!" -Verbose')).not.toContain('Sup3rSecret!');
    expect(redactSecrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dbsfjgnsdkfgnskjdf')).toBe('[redacted]');
    expect(redactSecrets('echo hola mundo')).toBe('echo hola mundo');
  });
});

describe('contrato con el harness QA (toolOfQuestion)', () => {
  it('las cabeceras shell/computer siguen siendo parseables por qa.ts', () => {
    expect(toolOfQuestion(formatApprovalQuestion(call('shell', { command: 'ls' }), 'r'))).toBe('shell');
    expect(toolOfQuestion(formatApprovalQuestion(call('computer', { action: 'key', key: 'Enter' }), 'r'))).toBe('computer');
  });
});

describe('browser y resto: sin cambios de formato', () => {
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

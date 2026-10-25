import { describe, expect, it } from 'vitest';
import { formatApproval, formatApprovalQuestion, redactSecrets } from '../src/approval-text.js';
import { toolOfQuestion } from '../src/channels/qa.js';

const call = (tool: string, args: Record<string, unknown>) => ({ tool, args, actor: 'asistenta' });

describe('aprobaciones: lo que se muestra es lo que se aprueba', () => {
  it('shell muestra el comando entero y el motivo', () => {
    const a = formatApproval(
      call('shell', { command: 'Remove-Item ./tmp -Recurse' }),
      'riesgo: borrado',
    );
    expect(a.complete).toBe(true);
    expect(a.question).toContain('¿Permito shell?');
    expect(a.question).toContain('Remove-Item ./tmp -Recurse');
    expect(a.question).toContain('Motivo: riesgo: borrado');
  });

  it('canario: mismo prefijo, colas distintas → preguntas aprobables siempre distintas', () => {
    const prefix = `Get-ChildItem ${'x'.repeat(1200)}`;
    const safe = formatApproval(call('shell', { command: prefix }), 'r');
    const evil = formatApproval(
      call('shell', { command: `${prefix}; Remove-Item C:\\ -Recurse -Force` }),
      'r',
    );
    expect(safe.complete).toBe(true);
    expect(evil.complete).toBe(true);
    expect(safe.question === evil.question).toBe(false);
    // Sobre presupuesto: NINGUNO es aprobable (fail-closed).
    const longPrefix = `Get-ChildItem ${'x'.repeat(3600)}`;
    const safeLong = formatApproval(call('shell', { command: longPrefix }), 'r');
    const evilLong = formatApproval(
      call('shell', { command: `${longPrefix}; Remove-Item C:\\ -Recurse -Force` }),
      'r',
    );
    expect(safeLong.complete).toBe(false);
    expect(evilLong.complete).toBe(false);
    expect(safeLong.question).toContain('DENEGADA');
    expect(safeLong.question).not.toContain('xxxx');
  });

  it('canario: la redacción NO se come la operación tras el secreto', () => {
    // El canario del auditor: dos comandos con secreto distinto y cola distinta
    // deben producir preguntas distintas y con la cola intacta.
    const a = redactSecrets('password=abc;Remove-Item');
    const b = redactSecrets('password=def;Get-ChildItem');
    expect(a).toBe('password=[redacted];Remove-Item');
    expect(b).toBe('password=[redacted];Get-ChildItem');
    expect(a === b).toBe(false);
    expect(a).not.toContain('abc');
  });

  it('canario: valores entrecomillados se enmascaran ENTEROS (sin fuga parcial)', () => {
    const out = redactSecrets(`password="abc def ghi" && echo ok`);
    expect(out).toBe('password=[redacted] && echo ok');
    expect(out).not.toContain('abc');
    expect(out).not.toContain('def');
  });

  it('canario: el motivo también se redacta antes de salir al canal', () => {
    const a = formatApproval(call('shell', { command: 'ls' }), 'usa token=TEST_REASON_SECRET');
    expect(a.question).not.toContain('TEST_REASON_SECRET');
    expect(a.question).toContain('token=[redacted]');
  });

  it('canario: el presupuesto se mide sobre el RAW, no sobre el texto redactado', () => {
    // token= enmascara 8 chars, pero el comando RAW pasa de 3500: debe denegar.
    const command = `token=abc; ${'x'.repeat(3600)}`;
    const a = formatApproval(call('shell', { command }), 'r');
    expect(a.complete).toBe(false);
    expect(a.question).toContain('DENEGADA');
    // Y un comando sin secreto que cabe en RAW se muestra entero y aprobable.
    const ok = formatApproval(call('shell', { command: 'ls -la /tmp' }), 'r');
    expect(ok.complete).toBe(true);
    expect(ok.question).toContain('ls -la /tmp');
  });

  it('computer type con secret: true se DENIEGA (ni mostrarlo ni aprobar a ciegas)', () => {
    const a = formatApproval(
      call('computer', { action: 'type', text: 'TEST_PASSWORD_UNLABELLED', secret: true }),
      'r',
    );
    expect(a.complete).toBe(false);
    expect(a.question).toContain('DENEGADA');
    expect(a.question).not.toContain('TEST_PASSWORD_UNLABELLED');
  });

  it('canario: subexpresión de PowerShell entre comillas => DENEGADO, no enmascarado', () => {
    // El canario del auditor: "$(...)" dentro de comillas dobles EJECUTA. Si se
    // enmascarara como secreto, una operación destructiva quedaría oculta.
    const evil = formatApproval(
      call('shell', { command: 'password="$(Remove-Item C:/Data -Recurse)"' }),
      'r',
    );
    const benign = formatApproval(call('shell', { command: 'password="$(Get-Date)"' }), 'r');
    expect(evil.complete).toBe(false);
    expect(benign.complete).toBe(false);
    expect(evil.question).toContain('DENEGADA');
    expect(evil.question).not.toContain('Remove-Item');
  });

  it('un comando que el enmascarado alteraría se DENIEGA en vez de mostrarse alterado', () => {
    const a = formatApproval(call('shell', { command: 'token=abc123; ls' }), 'r');
    expect(a.complete).toBe(false);
    expect(a.question).toContain('DENEGADA');
    // Sin secreto, el mismo comando se muestra entero y aprobable.
    const ok = formatApproval(call('shell', { command: 'ls' }), 'r');
    expect(ok.complete).toBe(true);
    expect(ok.question).toContain('ls');
  });

  it('batch con un paso type secreto => DENEGADO entero', () => {
    const a = formatApproval(
      call('computer', {
        action: 'batch',
        actions: [
          { action: 'click', x: 1, y: 1 },
          { action: 'type', text: 'x', secret: true },
        ],
      }),
      'r',
    );
    expect(a.complete).toBe(false);
    expect(a.question).toContain('DENEGADA');
  });

  it('type sin marca cuyo texto tiene forma de secreto => DENEGADO (no se muestra alterado)', () => {
    const a = formatApproval(call('computer', { action: 'type', text: 'token=abc123' }), 'r');
    expect(a.complete).toBe(false);
    expect(a.question).not.toContain('abc123');
  });

  it('computer describe click con todos sus parámetros', () => {
    const base = { action: 'click', x: 1, y: 2 };
    const q = (extra: Record<string, unknown>) =>
      formatApproval(call('computer', { ...base, ...extra }), 'r').question;
    expect(q({ button: 'right' })).toContain('click derecho en (1, 2)');
    expect(q({ clicks: 2 })).toContain('click x2 en (1, 2)');
    expect(q({ roi: { x: 0, y: 0, width: 10, height: 10 } })).toContain('[roi (0, 0, 10×10)]');
    const variants = [
      q({}),
      q({ button: 'right' }),
      q({ clicks: 3 }),
      q({ roi: { x: 1, y: 1, width: 5, height: 5 } }),
    ];
    expect(new Set(variants).size).toBe(4);
  });

  it('canario: drag a destinos distintos → preguntas distintas', () => {
    const a = formatApproval(call('computer', { action: 'drag', x: 1, y: 1, toX: 5, toY: 5 }), 'r');
    const b = formatApproval(call('computer', { action: 'drag', x: 1, y: 1, toX: 9, toY: 9 }), 'r');
    expect(a.question).toContain('a (5, 5)');
    expect(b.question).toContain('a (9, 9)');
    expect(a.question === b.question).toBe(false);
  });

  it('batch lista TODAS las acciones, sin "y N más"', () => {
    const actions = Array.from({ length: 12 }, (_, i) => ({ action: 'click', x: i, y: i }));
    const a = formatApproval(call('computer', { action: 'batch', actions }), 'r');
    expect(a.complete).toBe(true);
    expect(a.question).toContain('Lote de 12 acciones:');
    expect(a.question).toContain('12. click en (11, 11)');
    expect(a.question).not.toMatch(/y \d+ más/);
  });

  it('batch de 500 acciones excede el presupuesto RAW → fail-closed', () => {
    const actions = Array.from({ length: 500 }, (_, i) => ({ action: 'click', x: i, y: i }));
    const a = formatApproval(call('computer', { action: 'batch', actions }), 'r');
    expect(a.complete).toBe(false);
    expect(a.question).toContain('DENEGADA');
    expect(a.question).not.toContain('click en');
  });

  it('acción desconocida y parámetros desconocidos se muestran enteros', () => {
    const a = formatApproval(call('computer', { action: 'teleport', x: 1, level: 3 }), 'r');
    expect(a.complete).toBe(true);
    expect(a.question).toContain('teleport');
    expect(a.question).toContain('"level":3');
    const b = formatApproval(
      call('computer', { action: 'click', x: 1, y: 2, region: 'pop-up' }),
      'r',
    );
    expect(b.question).toContain('{region: "pop-up"}');
    // Con algo con forma de secreto dentro: DENEGADO, no enmascarado.
    const c = formatApproval(
      call('computer', { action: 'teleport', token: 'ghp_abcdefghijklmnop' }),
      'r',
    );
    expect(c.complete).toBe(false);
    expect(c.question).not.toContain('ghp_abcdefghijklmnop');
  });

  it('redacción: curl bearer, flag PowerShell y JWT', () => {
    const curlOut = redactSecrets('curl -H "Authorization: Bearer abc123xyz"');
    expect(curlOut).not.toContain('abc123xyz');
    expect(curlOut).toContain('[redacted]');
    expect(redactSecrets("Connect -Password 'hunter2 secret'")).not.toContain('hunter2');
    const jwt = 'eyJaaaaaaaaaa.bbbbbbbbbb.ccccc';
    expect(redactSecrets(`echo ${jwt}`)).toBe('echo [redacted]');
  });

  it('browser y genérico conservan su formato', () => {
    const b = formatApproval(call('browser', { _target: 'button | Comprar' }), 'r');
    expect(b.question).toContain('¿Permito esta acción en el navegador?');
    expect(b.question).toContain('button · Comprar');
    // Escribir ya no es una pregunta a ciegas: ruta y contenido van en el texto.
    const g = formatApproval(call('write', { path: '/tmp/x', content: 'hola' }), 'escribe fichero');
    expect(g.question).toContain('¿Permito escribir?');
    expect(g.question).toContain('Archivo: /tmp/x');
    expect(g.question).toContain('hola');
  });

  it('ninguna pregunta aprobable supera el presupuesto', () => {
    const longReason = `porque ${'y'.repeat(4000)}`;
    const a = formatApproval(call('shell', { command: 'ls' }), longReason);
    expect(a.complete).toBe(false);
  });
});

describe('contrato con el harness QA (toolOfQuestion)', () => {
  it('las cabeceras estables parsean a su herramienta', () => {
    expect(toolOfQuestion(formatApprovalQuestion(call('shell', { command: 'ls' }), 'r'))).toBe(
      'shell',
    );
    expect(
      toolOfQuestion(
        formatApprovalQuestion(call('computer', { action: 'click', x: 1, y: 1 }), 'r'),
      ),
    ).toBe('computer');
  });
});

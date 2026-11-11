import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { recordatorioAprobacion } from '../src/webui/client-format.js';
import { renderFormatScript, renderPage } from '../src/webui/page.js';

const MIN = 60_000;
const pendiente = { id: 'apr_1', createdAt: 1_000_000, expiresAt: 1_000_000 + 5 * MIN };

function scripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

describe('gaps-13: recordatorio de aprobación también en el panel', () => {
  it('a los 3 min sin respuesta recuerda cuánto queda; antes, nada', () => {
    expect(recordatorioAprobacion(pendiente, pendiente.createdAt + 2 * MIN)).toBe('');
    expect(recordatorioAprobacion(pendiente, pendiente.createdAt + 3 * MIN)).toBe(
      '⏳ Sigue esperando tu respuesta: si no decides, en 2 min caduca y no hago nada.',
    );
    expect(recordatorioAprobacion(pendiente, pendiente.createdAt + 4.5 * MIN)).toContain(
      'en 1 min',
    );
  });

  it('nada si ya caducó, si dura menos de 4 min o si faltan las fechas', () => {
    expect(recordatorioAprobacion(pendiente, pendiente.expiresAt)).toBe('');
    expect(recordatorioAprobacion({ createdAt: 0, expiresAt: 3 * MIN }, 2.9 * MIN)).toBe('');
    expect(recordatorioAprobacion({ expiresAt: 5 * MIN }, 4 * MIN)).toBe('');
    expect(recordatorioAprobacion('texto', 4 * MIN)).toBe('');
    expect(
      recordatorioAprobacion(
        { createdAt: '2026-11-11T15:00:00Z', expiresAt: '2026-11-11T15:05:00Z' },
        Date.parse('2026-11-11T15:03:30Z'),
      ),
    ).toContain('en 2 min');
  });

  it('la copia del navegador hace lo mismo', () => {
    const ctx: { asistentaFormato?: { recordatorioAprobacion: typeof recordatorioAprobacion } } =
      {};
    runInNewContext(
      renderFormatScript().replace('var asistentaFormato', 'this.asistentaFormato'),
      ctx,
    );
    expect(
      ctx.asistentaFormato?.recordatorioAprobacion(pendiente, pendiente.createdAt + 3 * MIN),
    ).toBe(recordatorioAprobacion(pendiente, pendiente.createdAt + 3 * MIN));
  });

  it('el panel lo pinta una vez por aprobación, marca la pestaña y no pide permisos de avisos', () => {
    const html = renderPage();
    for (const bloque of scripts(html)) expect(() => new Function(bloque)).not.toThrow();
    expect(html).toContain("tarjeta.setAttribute('data-creada'");
    expect(html).toContain('recordarAprobaciones(ahora);');
    expect(html).toContain('aprobacionesRecordadas[id] = true;');
    expect(html).toContain("Notification.permission !== 'granted'");
    // gaps-14: el permiso solo se pide al tocar «🔔 Activar avisos», nunca solo.
    const pide = html.indexOf('Notification.requestPermission');
    expect(html.lastIndexOf('Notification.requestPermission')).toBe(pide);
    expect(html.lastIndexOf("b.addEventListener('click'", pide)).toBeGreaterThan(
      html.lastIndexOf("getElementById('activar-avisos')", pide),
    );
    expect(html).toContain('.aprobacion .recordatorio');
  });
});

import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { desfaseReloj, recordatorioAprobacion } from '../src/webui/client-format.js';
import { renderFormatScript, renderPage } from '../src/webui/page.js';

// bugs-36 (lead de bugs-35, revisión de #2338): las aprobaciones traen la hora del PC
// (createdAt/expiresAt) y el panel las comparaba con el reloj del navegador. Con el móvil
// por Tailscale 4 min atrasado respecto al PC, el «⏳ Sigue esperando…» no salía nunca (la
// aprobación caducaba antes de que el navegador viera pasar 3 min) y la cuenta atrás
// mentía; adelantado, salía nada más pedirse.

const MIN = 60_000;

describe('el panel cuenta con la hora del PC', () => {
  it('desfaseReloj lee la cabecera Date', () => {
    const navegador = Date.parse('2026-11-11T15:00:00.000Z');
    // El PC va 4 min por delante del navegador.
    const pc = new Date(navegador + 4 * MIN).toUTCString();
    expect(Math.abs(desfaseReloj(pc, navegador - 100, navegador + 100, 0) - 4 * MIN)).toBeLessThan(
      1000,
    );
    // Y 4 min por detrás.
    const atras = new Date(navegador - 4 * MIN).toUTCString();
    expect(
      Math.abs(desfaseReloj(atras, navegador - 100, navegador + 100, 0) + 4 * MIN),
    ).toBeLessThan(1000);
  });

  it('con relojes iguales, sin cabecera o con una respuesta lenta, no cambia nada', () => {
    const t = Date.parse('2026-11-11T15:00:00.000Z');
    expect(desfaseReloj(new Date(t).toUTCString(), t, t + 50, 0)).toBe(0);
    expect(desfaseReloj(null, t, t + 50, 1234)).toBe(1234);
    expect(desfaseReloj('no es una fecha', t, t + 50, 1234)).toBe(1234);
    expect(desfaseReloj(new Date(t + 4 * MIN).toUTCString(), t, t + 9000, 77)).toBe(77);
  });

  it('con el desfase, el recordatorio sale a los 3 min del PC', () => {
    const creada = Date.parse('2026-11-11T15:00:00.000Z');
    const pendiente = { createdAt: creada, expiresAt: creada + 5 * MIN };
    // El navegador va 4 min atrasado: su «ahora» a los 3 min del PC es creada - 1 min.
    const navegador = creada + 3 * MIN - 4 * MIN;
    expect(recordatorioAprobacion(pendiente, navegador)).toBe('');
    const desfase = desfaseReloj(
      new Date(creada + 3 * MIN).toUTCString(),
      navegador - 50,
      navegador + 50,
      0,
    );
    expect(recordatorioAprobacion(pendiente, navegador + desfase)).toContain('en 2 min');
  });

  it('la copia del navegador hace lo mismo y la página la usa', () => {
    const ctx: { asistentaFormato?: { desfaseReloj: typeof desfaseReloj } } = {};
    runInNewContext(
      renderFormatScript().replace('var asistentaFormato', 'this.asistentaFormato'),
      ctx,
    );
    const t = Date.parse('2026-11-11T15:00:00.000Z');
    const pc = new Date(t + 4 * MIN).toUTCString();
    expect(ctx.asistentaFormato?.desfaseReloj(pc, t, t + 10, 0)).toBe(
      desfaseReloj(pc, t, t + 10, 0),
    );
    const html = renderPage();
    expect(html).toContain("formato.desfaseReloj(respuesta.headers.get('Date')");
    const caducidades = html.slice(html.indexOf('function actualizarCaducidades()'));
    expect(caducidades.slice(0, 120)).toContain('var ahora = ahoraPC();');
    expect(html).toContain('formato.tiempoRestante(resumen.caduca, ahoraPC())');
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
      expect(() => new Function(m[1] ?? '')).not.toThrow();
  });
});

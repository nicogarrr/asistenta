import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Extrae una función del script del panel por su nombre (cuerpo hasta la llave de cierre a 6 espacios).
function funcion(html: string, nombre: string): string {
  const inicio = html.indexOf(`function ${nombre}(`);
  expect(inicio).toBeGreaterThan(-1);
  const fin = html.indexOf('\n      }\n', inicio);
  return html.slice(inicio, fin + 8);
}

function montar(token: string) {
  const html = renderPage();
  const documento = { visibilityState: 'visible' };
  let cargas = 0;
  const fuente = `var ocultaDesde = 0;\n${funcion(html, 'alCambiarVisibilidad')}\nreturn alCambiarVisibilidad;`;
  const cambiar = new Function(
    'document',
    'token',
    'cargarAprobacionesEnSilencio',
    'cargarRutinas',
    fuente,
  )(
    documento,
    token,
    () => {
      cargas += 1;
    },
    () => {},
  ) as () => void;
  const ir = (estado: 'visible' | 'hidden') => {
    documento.visibilityState = estado;
    cambiar();
  };
  return { ir, cargas: () => cargas, html };
}

describe('panel: aprobaciones al volver a la pestaña', () => {
  it('recarga las aprobaciones en cuanto la pestaña vuelve a estar visible', () => {
    const p = montar('demo');
    p.ir('hidden');
    expect(p.cargas()).toBe(0);
    p.ir('visible');
    expect(p.cargas()).toBe(1);
  });

  it('no recarga sin haber estado oculta ni dos veces por la misma vuelta', () => {
    const p = montar('demo');
    p.ir('visible');
    expect(p.cargas()).toBe(0);
    p.ir('hidden');
    p.ir('hidden');
    p.ir('visible');
    p.ir('visible');
    expect(p.cargas()).toBe(1);
  });

  it('sin token no pide nada', () => {
    const p = montar('');
    p.ir('hidden');
    p.ir('visible');
    expect(p.cargas()).toBe(0);
  });

  it('el script escucha visibilitychange con esa función', () => {
    expect(montar('demo').html).toContain(
      "addEventListener('visibilitychange', alCambiarVisibilidad)",
    );
  });
});

describe('panel: aprobaciones caducadas legibles', () => {
  it('la tarjeta caducada se atenúa con color, no con opacidad', () => {
    const html = renderPage();
    const reglas = html.match(/\.aprobacion\.caducada[^{]*\{[^}]*\}/g) ?? [];
    expect(reglas.length).toBeGreaterThan(0);
    const tarjeta = reglas.find((r) => r.startsWith('.aprobacion.caducada {')) ?? '';
    expect(tarjeta).not.toMatch(/opacity/);
    expect(html).toMatch(/\.aprobacion\.caducada \.pregunta \{[^}]*color: var\(--suave\)/);
    expect(html).toMatch(/\.aprobacion\.caducada \.botones button:disabled \{[^}]*opacity: 1/);
  });
});

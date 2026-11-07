import { describe, expect, it } from 'vitest';
import { textoDiagnostico } from '../src/voice/diagnostico-voz.js';
import { renderVozPage } from '../src/webui/voz-page.js';

const etapas = [{ etapa: 'pensar' as const, ms: 1200, ok: true, detalle: '' }];

describe('voz7: sin red y modelo de reserva, dicho claro', () => {
  it('la página distingue «sin conexión en el móvil» de Asistenta rota', () => {
    const html = renderVozPage();
    expect(html).toContain('Sin conexión en el móvil');
    expect(html).toContain("window.addEventListener('offline'");
    const mandar = html.slice(
      html.indexOf('function mandar('),
      html.indexOf("boton.addEventListener('click'"),
    );
    // Sin red ni se intenta: el audio queda para «Reintentar».
    expect(mandar).toContain('if (navigator.onLine === false) { fallo(SIN_CONEXION');
    expect(mandar).toContain('fallo(sinRed()');
    expect(html).not.toContain('No llego al PC. ¿Tailscale está conectado?');
  });

  it('el diagnóstico dice si hay modelo de reserva para cuando el principal se satura', () => {
    expect(textoDiagnostico(etapas, 4, [])).toContain('Sin modelo de reserva');
    expect(textoDiagnostico(etapas, 4, [])).toContain('PA_FALLBACK_MODEL');
    expect(textoDiagnostico(etapas, 4, ['glm-4.6', 'kimi-k2'])).toContain(
      'Modelo de reserva si el principal se satura: glm-4.6, kimi-k2.',
    );
    expect(textoDiagnostico(etapas, 4)).not.toContain('reserva');
  });
});

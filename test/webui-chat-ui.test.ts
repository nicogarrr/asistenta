import { describe, expect, it } from 'vitest';
import { textoEspera } from '../src/webui/client-format.js';
import { renderPage } from '../src/webui/page.js';

describe('panel: chat con conversación, espera visible y reintento', () => {
  it('cuenta el tiempo de espera', () => {
    expect(textoEspera(0)).toBe('Pensando… 0 s');
    expect(textoEspera(12_400)).toBe('Pensando… 12 s');
    expect(textoEspera(65_000)).toBe('Pensando… 1 min 05 s');
    expect(textoEspera(-5)).toBe('Pensando… 0 s');
  });

  it('la página conserva la conversación, muestra la espera y ofrece reintentar', () => {
    const html = renderPage();
    expect(html).toContain('role="log"');
    expect(html).toContain("anadirTurno('yo', 'Tú', texto)");
    expect(html).toContain('formato.textoEspera(Date.now() - inicio)');
    expect(html).toContain('enviarChat(null, texto)');
    // Antes cada respuesta borraba la anterior.
    expect(html).not.toContain("panel.replaceChildren(nodo('p', 'texto', respuesta))");
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Function(m[1] ?? '')).not.toThrow();
    }
  });
});

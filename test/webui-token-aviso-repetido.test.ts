import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';

// Token rechazado sin navegador: el código real de mostrarAviso/pedirToken con un aviso
// falso (role=alert). Cada refresco silencioso vuelve a recibir 401; el lector no debe
// anunciar el mismo aviso cada 15 s.
function montar() {
  const html = renderPage();
  const trozo = (desde: string, hasta: string) => {
    const a = html.indexOf(desde);
    const b = html.indexOf(hasta, a);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    return html.slice(a, b);
  };
  let texto = '';
  let escrituras = 0;
  const aviso = {
    hidden: true,
    get textContent() {
      return texto;
    },
    set textContent(v: string) {
      texto = v;
      escrituras++;
    },
  };
  const form = { hidden: true };
  const document = { getElementById: (id: string) => (id === 'form-token' ? form : null) };
  const fuente = `${trozo('function mostrarAviso', 'function nodo')}\n${trozo('function pedirToken', 'async function llamar')}\nreturn { mostrarAviso, pedirToken };`;
  const api = new Function('document', 'aviso', fuente)(document, aviso);
  return { api, aviso, form, escrituras: () => escrituras };
}

describe('aviso de token rechazado', () => {
  it('no reescribe (ni re-anuncia) el mismo aviso en cada refresco', () => {
    const { api, aviso, form, escrituras } = montar();
    const t = 'Token rechazado: pega el token correcto (PA_WEB_TOKEN).';
    api.pedirToken(t);
    api.pedirToken(t);
    api.pedirToken(t);
    expect(aviso.textContent).toBe(t);
    expect(aviso.hidden).toBe(false);
    expect(form.hidden).toBe(false);
    expect(escrituras()).toBe(1);
  });

  it('un aviso nuevo o uno que vuelve tras borrarse sí se escribe', () => {
    const { api, aviso, escrituras } = montar();
    api.mostrarAviso('A');
    api.mostrarAviso('');
    expect(aviso.hidden).toBe(true);
    api.mostrarAviso('A');
    api.mostrarAviso('B');
    expect(aviso.textContent).toBe('B');
    expect(escrituras()).toBe(4);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserService,
  isSameName,
  normalizeText,
  rankSuggestion,
  similarity,
} from '../src/browser/service.js';
import { createBrowserTool } from '../src/tools/browser.js';

/**
 * The browser against real pages that break in the ways real pages break.
 *
 * No mocks, on purpose. Every defect this file exists for was a defect of timing and of
 * DOM that a mocked page cannot have: a suggestion panel that is not there yet when you
 * look, a button that appears half a second later, a dead URL. A fake page with instant
 * elements passes all of them.
 *
 * The pages are served from localhost by the server below, so the whole file is offline:
 * the 404 case needs a real HTTP status, and the rest needs a real document load.
 */

/** Autocomplete that takes 500ms to paint its suggestions, like a real one. */
const AUTOCOMPLETE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Viajes</title>
<style>
  body { font-family: system-ui; margin: 20px; }
  #panel { display: none; border: 1px solid #999; width: 260px; }
  [role=option] { padding: 4px 6px; cursor: pointer; }
</style></head>
<body>
  <h1>Buscar tren</h1>
  <label for="origen">Origen</label>
  <input id="origen" type="text" placeholder="Desde" autocomplete="off">
  <label for="fecha">Fecha</label>
  <input id="fecha" type="text" value="03/10/2026">
  <div id="panel" role="listbox" aria-label="Sugerencias"></div>
  <button id="buscar">Buscar</button>
  <div id="resultado" style="display:none">Hay 4 trenes</div>
  <script>
    const DATOS = ['(TODAS)', 'Madrid', 'Madrid-Chamartín', 'Málaga', 'Murcia', 'Mérida'];
    const input = document.getElementById('origen');
    const panel = document.getElementById('panel');
    let timer = null;
    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      // The panel only exists after a delay. Reading the page before that is exactly the
      // failure that made an agent decide there were no suggestions to choose from.
      timer = setTimeout(() => {
        const q = input.value.toLowerCase();
        const hits = DATOS.filter((d) => d.toLowerCase().includes(q)).slice(0, 4);
        panel.innerHTML = '';
        for (const texto of hits) {
          const op = document.createElement('div');
          op.setAttribute('role', 'option');
          op.textContent = texto;
          op.addEventListener('click', () => {
            input.value = texto;
            panel.style.display = 'none';
          });
          panel.appendChild(op);
        }
        panel.style.display = hits.length ? 'block' : 'none';
      }, 500);
    });
    document.getElementById('buscar').addEventListener('click', () => {
      document.getElementById('resultado').style.display = 'block';
    });
    setTimeout(() => { document.getElementById('resultado').style.display = 'none'; }, 0);
  </script>
</body></html>`;

/** A button that only exists after 300ms, and two almost identical station buttons. */
const LATE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Estaciones</title></head>
<body>
  <input id="destino" type="text" placeholder="Destino">
  <ul id="lista" role="listbox"></ul>
  <button id="tarde">Barcelona</button>
  <button id="tarde2">Barcelona Sants</button>
  <p id="salida"></p>
  <script>
    const lista = document.getElementById('lista');
    for (const texto of ['Barcelona', 'Barcelona Sants']) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.textContent = texto;
      li.addEventListener('click', () => {
        document.getElementById('destino').value = texto;
        lista.innerHTML = '';
      });
      lista.appendChild(li);
    }
    const destino = document.getElementById('destino');
    destino.addEventListener('input', () => {
      if (!destino.value) lista.innerHTML = '';
    });
    setTimeout(() => {
      const b = document.createElement('button');
      b.id = 'aparecido';
      b.textContent = 'Cargar más';
      document.body.appendChild(b);
    }, 300);
    for (const id of ['tarde', 'tarde2']) {
      document.getElementById(id).addEventListener('click', () => {
        document.getElementById('salida').textContent = 'pulsado ' + id;
      });
    }
  </script>
</body></html>`;

const HOME = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Portada</title></head><body><h1>Portada</h1><p>Bienvenido</p></body></html>`;

function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HOME);
      return;
    }
    if (path === '/autocomplete') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(AUTOCOMPLETE);
      return;
    }
    if (path === '/tarde') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LATE);
      return;
    }
    // The deep link an agent invents from memory: 404, exactly like renfe.com/es/es/...
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>No encontrado</body></html>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe('browser: fiabilidad en páginas reales', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-reliable-'));
  const service = new BrowserService({
    policy: {
      autoApprove: true,
      // The fixture server is on 127.0.0.1 and the browser refuses private addresses by
      // default, which is the right default and useless here.
      allowPrivateHosts: true,
      // The advert watcher is not what this file tests, and a poll every second would
      // click things on the test pages.
      adSkipIntervalMs: 0,
      approve: async () => true,
    },
    profilesDir: join(root, 'profiles'),
    timeoutMs: 15_000,
  });
  const tool = createBrowserTool(service, () => 'reliable#main');
  const scope = 'reliable#main';

  let base = '';

  const call = async (args: Record<string, unknown>): Promise<string> => {
    const res = await tool.execute('id', args as never);
    const first = res.content[0] as { text: string };
    return first.text;
  };

  const go = async (path: string): Promise<void> => {
    await service.open(scope, `${base}${path}`, { visible: false });
  };

  beforeAll(async () => {
    const started = await startServer();
    base = started.base;
  });

  afterAll(async () => {
    await service.closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  describe('autocompletado que tarda 500ms en pintar', () => {
    beforeAll(async () => {
      await go('/autocomplete');
    });

    it('pick elige la sugerencia correcta y el campo queda con ese valor', async () => {
      const result = await service.pick(scope, { label: 'Madrid-Chamartín', from: '#origen' });
      expect(result.ok).toBe(true);
      expect(result.chosen).toBe('Madrid-Chamartín');
      // The field really holds it: a pick that only reports success is the failure this
      // whole action exists to remove.
      const value = await service.execJs(
        scope,
        'return await page.locator("#origen").inputValue();',
      );
      expect(value.text).toBe('Madrid-Chamartín');
    });

    it('pick es idempotente: llamarlo dos veces no rompe nada', async () => {
      const again = await service.pick(scope, { label: 'Madrid-Chamartín', from: '#origen' });
      expect(again.ok).toBe(true);
      expect(again.alreadySet).toBe(true);
      const value = await service.execJs(
        scope,
        'return await page.locator("#origen").inputValue();',
      );
      expect(value.text).toBe('Madrid-Chamartín');
    });

    it('con una etiqueta inexistente falla y lista lo que sí apareció', async () => {
      const result = await service.pick(scope, { label: 'Vigo', from: '#origen' });
      expect(result.ok).toBe(false);
      // Without the options in the message there is nothing to retry with, so this is
      // the assertion that matters most in the whole failure path.
      expect(result.options.length).toBeGreaterThan(0);
      expect(result.options.join('|')).toContain('Madrid');
      expect(result.reason).toContain('Vigo');
    });

    it('el snapshot avisa de las sugerencias abiertas y enseña el value de los campos', async () => {
      // Type without choosing, so the panel is left open for the snapshot to see.
      await service.execJs(
        scope,
        `await page.locator('#origen').fill('');
         await page.locator('#origen').pressSequentially('M', { delay: 10 });
         await page.waitForTimeout(900);
         return 'typed';`,
      );
      const snap = await service.snapshot(scope);
      expect(snap).toContain('sugerencias abiertas');
      expect(snap).toMatch(/Madrid/);
      // The value of a filled field is the fact that was missing before: without it the
      // model cannot tell that the date box already says 03/10.
      expect(snap).toMatch(/value="03\/10\/2026"/);
      // Kind and role are there so a locator can be built from the snapshot alone.
      expect(snap).toMatch(/input#fecha\[textbox\]/);
      expect(snap).toMatch(/\[button\]/);
      expect(snap).toMatch(/\[\d+\]/);
    });
  });

  describe('botón que aparece a los 300ms', () => {
    beforeAll(async () => {
      await go('/tarde');
      await service.execJs(scope, 'return null;');
    });

    it('wait encuentra lo que aparece tarde y dice cuánto tardó', async () => {
      const result = await service.waitFor(scope, { selector: '#aparecido' }, 3000);
      expect(result.ok).toBe(true);
      expect(result.waitedMs).toBeGreaterThanOrEqual(0);
      expect(result.waitedMs).toBeLessThan(3000);
    });

    it('wait de algo que no aparece nunca no lanza: devuelve el motivo y los candidatos', async () => {
      const started = Date.now();
      const result = await service.waitFor(scope, { selector: '#nunca-existe' }, 600);
      expect(result.ok).toBe(false);
      // It waited, it did not throw, and it answered.
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
      expect(result.reason).toContain('#nunca-existe');
      expect(result.reason).toContain('Barcelona');
      expect(result.candidates.length).toBeGreaterThan(0);
    });

    it('wait también acepta texto visible', async () => {
      const result = await service.waitFor(scope, { text: 'Cargar más' }, 2000);
      expect(result.ok).toBe(true);
    });

    it('pick elige el exacto y no el primero que contiene el texto', async () => {
      const result = await service.pick(scope, { label: 'Barcelona', from: '#destino' });
      expect(result.ok).toBe(true);
      expect(result.chosen).toBe('Barcelona');
      const value = await service.execJs(
        scope,
        'return await page.locator("#destino").inputValue();',
      );
      expect(value.text).toBe('Barcelona');
    });

    it('click con texto en vez de selector encuentra el botón', async () => {
      const result = await service.clickTarget(scope, 'Cargar más');
      expect(result.ok).toBe(true);
      expect(result.clicked).toBe(true);
    });

    it('fill acepta la etiqueta del campo en vez de su selector, y lo verifica', async () => {
      const text = await call({ action: 'fill', selector: 'Destino', text: 'Sevilla' });
      // Resolved by label, so there is no selector to fall back on: the action still
      // has to type into the right box and say so.
      expect(text).toContain('filled');
      const value = await service.execJs(
        scope,
        'return await page.locator("#destino").inputValue();',
      );
      expect(value.text).toBe('Sevilla');
    });

    it('press también usa el elemento resuelto, sin pedir un selector', async () => {
      const text = await call({ action: 'press', selector: 'Destino', key: 'Enter' });
      expect(text).toContain('pressed Enter');
    });

    it('click con un texto inexistente lista lo más parecido en vez de rendirse', async () => {
      const result = await service.clickTarget(scope, 'Seleccionar Barcelona');
      expect(result.ok).toBe(false);
      // "No encontré X" no es utilizable; "lo más parecido es Barcelona" sí.
      expect(result.error).toContain('Barcelona Sants');
      expect(result.candidates).toContain('Barcelona');
    });

    it('el mensaje de la tool dice que no ha podido, sin lanzar excepción', async () => {
      const text = await call({ action: 'click', selector: 'Seleccionar Barcelona' });
      expect(text).toContain('Lo más parecido');
      expect(text).toContain('Barcelona Sants');
    });

    it('wait desde la tool responde igual y sin excepción', async () => {
      const text = await call({
        action: 'wait',
        with: '#nunca-existe',
        timeoutMs: 500,
      });
      expect(text).toContain('no ha aparecido');
      expect(text).toContain('headless');
    });
  });

  describe('open contra una url que no existe', () => {
    it('reintenta en la raíz del sitio y lo dice en el resultado', async () => {
      const info = await service.open(scope, `${base}/inspirate/experiencias/rio`);
      expect(info.status).toBe(404);
      expect(info.retryFromRoot).toBe(true);
      expect(info.note).toContain('pagina principal');
      // The browser really is on the home page now, not on the invented deep link.
      expect(info.url).toBe(`${base}/`);
      expect(info.title).toBe('Portada');
    });

    it('la tool cuenta en el mensaje que se ha caído a la home', async () => {
      const text = await call({ action: 'open', url: `${base}/otra/pagina/que/no/existe` });
      expect(text).toContain('pagina principal');
      expect(text).toContain('Portada');
    });
  });

  describe('el modelo sabe si el usuario está mirando', () => {
    it('cada resultado dice si la ventana es visible', async () => {
      await go('/tarde');
      expect(service.isVisible(scope)).toBe(false);
      const snap = await call({ action: 'snapshot' });
      expect(snap).toContain('headless');
      const clicked = await call({ action: 'click', selector: 'Cargar más' });
      expect(clicked).toContain('headless');
    });

    it('con visible: true la ventana está en pantalla y el resultado lo dice', async () => {
      const result = await service.open(scope, `${base}/autocomplete`, { visible: true });
      expect(result.visible).toBe(true);
      expect(service.isVisible(scope)).toBe(true);
      const snap = await call({ action: 'snapshot' });
      expect(snap).toContain('VISIBLE');
      // Leave the suite headless again for whatever runs next.
      await service.close(scope);
    });
  });
});

describe('las comparaciones que sostienen el rescate', () => {
  it('normaliza acentos, mayúsculas y espacios', () => {
    expect(normalizeText('  Madrid-Chamartín ')).toBe('madrid-chamartin');
    expect(normalizeText('MÁLAGA')).toBe('malaga');
  });

  it('un texto parecido puntúa más que uno que no tiene nada que ver', () => {
    const cerca = similarity('Seleccionar Barcelona', 'Barcelona');
    const lejos = similarity('Seleccionar Barcelona', 'Cargar más');
    expect(cerca).toBeGreaterThan(0.5);
    expect(lejos).toBeLessThan(cerca);
    expect(similarity('Barcelona', 'Barcelona')).toBe(1);
  });

  it('elige el exacto antes que el que lo contiene, y el más corto dentro de un nivel', () => {
    const opciones = ['(TODAS)', 'Madrid', 'Madrid-Chamartín'];
    expect(opciones[rankSuggestion(opciones, 'Madrid')]).toBe('Madrid');
    expect(opciones[rankSuggestion(opciones, 'madrid')]).toBe('Madrid');
    // Sin exacto, se queda con el que empieza por lo pedido.
    expect(opciones[rankSuggestion(opciones, 'Madrid-Ch')]).toBe('Madrid-Chamartín');
    expect(rankSuggestion(opciones, 'Vigo')).toBe(-1);
  });

  it('dentro de un mismo nivel gana el texto más corto', () => {
    const opciones = ['Barcelona Sants', 'Barcelona'];
    expect(opciones[rankSuggestion(opciones, 'Barcelona')]).toBe('Barcelona');
  });

  it('el rescate por parecido no hace clic con un parecido flojo', () => {
    // Acentos, mayúsculas y erratas: mismo nombre, se puede pulsar.
    expect(isSameName('iniciar sesion', 'Iniciar sesión')).toBe(true);
    expect(isSameName('Barrcelona', 'Barcelona')).toBe(true);
    // Un nombre truncado: casi seguro que es el mismo botón.
    expect(isSameName('Comprar ahora', 'Comprar')).toBe(true);
    // Una palabra en común no es el mismo botón. Pulsar el equivocado aquí es peor que
    // no pulsar nada: reserva la ciudad equivocada.
    expect(isSameName('Seleccionar Barcelona', 'Barcelona')).toBe(false);
    expect(isSameName('Seleccionar Barcelona', 'Barcelona Sants')).toBe(false);
  });
});

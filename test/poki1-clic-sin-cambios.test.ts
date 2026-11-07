/**
 * Un clic que no cambia nada se dice (idea de POKI, reescrita): «enviado» no es «hecho».
 * Antes el navegador contestaba «clicked» aunque el botón estuviera tapado o no hiciera
 * nada, y el modelo daba por bueno el paso o volvía a pulsar a ciegas. Ahora, si la
 * página no cambió (dirección, texto, formulario, pestañas), el resultado lo dice.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService, clickChangeCheckOn } from '../src/browser/service.js';
import { createBrowserTool, NO_CHANGE_NOTE } from '../src/tools/browser.js';
import { describeBrowser } from './helpers/real-browser.js';

/** Servicio falso: solo lo que usa action=click. */
function fakeService(pageChanged: boolean | undefined) {
  const target = {
    ok: true,
    target: 'Enviar',
    selector: '#enviar',
    locatorJs: 'page.locator("#enviar")',
    how: 'css',
    clicked: true,
    waitedMs: 3,
    candidates: [],
    visible: false,
    ...(pageChanged === undefined ? {} : { pageChanged }),
  };
  return new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === 'clickTarget') return async () => target;
        if (key === 'then') return undefined;
        return async () => null;
      },
    },
  ) as unknown as BrowserService;
}

async function clickText(pageChanged: boolean | undefined): Promise<string> {
  const tool = createBrowserTool(fakeService(pageChanged), () => 'fake#main');
  const res = await tool.execute('id', { action: 'click', selector: '#enviar' } as never);
  return (res.content[0] as { text: string }).text;
}

describe('click: aviso cuando la página no cambió', () => {
  it('dice SIN_CAMBIOS si el clic no cambió nada', async () => {
    expect(await clickText(false)).toContain(NO_CHANGE_NOTE);
  });

  it('no añade nada si la página cambió o no se pudo medir', async () => {
    expect(await clickText(true)).not.toContain('SIN_CAMBIOS');
    expect(await clickText(undefined)).not.toContain('SIN_CAMBIOS');
  });

  it('PA_CLIC_CAMBIOS=0 apaga la comprobación', () => {
    expect(clickChangeCheckOn({})).toBe(true);
    expect(clickChangeCheckOn({ PA_CLIC_CAMBIOS: '0' })).toBe(false);
    expect(clickChangeCheckOn({ PA_CLIC_CAMBIOS: '1' })).toBe(true);
  });
});

const PAGE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Clics</title></head>
<body>
  <h1>Clics</h1>
  <button id="nada">No hago nada</button>
  <button id="texto" onclick="document.getElementById('out').textContent='Hecho'">Cambio el texto</button>
  <button id="tarde" onclick="setTimeout(()=>{document.getElementById('out').textContent='Tarde'},400)">Cambio tarde</button>
  <label><input id="caja" type="checkbox"> Acepto</label>
  <a id="ir" href="/otra">Ir a otra</a>
  <p id="out">Nada aún</p>
</body></html>`;

function serve(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/otra' ? '<!doctype html><html><body><h1>Otra</h1></body></html>' : PAGE);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describeBrowser('click: el navegador real dice si la página cambió', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-clic-cambios-'));
  const service = new BrowserService({
    policy: {
      autoApprove: true,
      allowPrivateHosts: true,
      adSkipIntervalMs: 0,
      approve: async () => true,
    },
    profilesDir: join(root, 'profiles'),
    timeoutMs: 15_000,
  });
  const scope = 'clics#main';
  let server: Server;
  let base = '';

  beforeAll(async () => {
    ({ server, base } = await serve());
  });
  afterAll(async () => {
    await service.closeAll();
    server?.close();
  });

  const open = async () => {
    await service.open(scope, base);
  };

  it('un botón que no hace nada: pageChanged false', async () => {
    await open();
    const r = await service.clickTarget(scope, '#nada');
    expect(r.clicked).toBe(true);
    expect(r.pageChanged).toBe(false);
  });

  it('un botón que cambia el texto, también tarde, y una casilla: pageChanged true', async () => {
    await open();
    expect((await service.clickTarget(scope, '#texto')).pageChanged).toBe(true);
    expect((await service.clickTarget(scope, '#tarde')).pageChanged).toBe(true);
    expect((await service.clickTarget(scope, '#caja')).pageChanged).toBe(true);
  });

  it('un enlace que navega: pageChanged true', async () => {
    await open();
    expect((await service.clickTarget(scope, '#ir')).pageChanged).toBe(true);
  });
});

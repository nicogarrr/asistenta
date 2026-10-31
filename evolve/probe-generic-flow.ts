/**
 * End-to-end proof of the GENERIC browser flow, on a site nothing here knows about.
 *
 * Deliberately not a site we have a tool for: the point is that nothing in this file
 * knows anything about the page. Every step uses only what a user could see - open the
 * root, click, type, read the suggestions, pick one, read the field back - and the
 * assertions are on the outcome, not on the calls made.
 *
 * It lives here, versioned, rather than in script/ because the self-improvement loop
 * measures every candidate in a fresh git worktree: a probe that is not committed cannot
 * be measured there, and an unmeasured candidate can never be promoted.
 *
 * Run: npx vite-node evolve/probe-generic-flow.ts
 *
 * The code under test (BrowserService) runs in a separate process, evolve/probe-agent.ts,
 * and this one only asks it to act and judges what comes back. When it ran here, the
 * candidate's own code shared this process: it could patch process.stdout or process.exit
 * and turn a FALLA into a PASA, or hide it, and the loop would score the forgery.
 */ import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countsAsBrowser, ownerLookupWorks } from './probe-owner.js';
import { connectionOwnerAny } from './probe-owner-os.js';
import { pngColourShare, type Rgb } from './probe-png.js';

// A tiny travel-ish site with the exact three things that broke the real run:
// a late-rendering autocomplete, a field that silently keeps its default, and a
// result page that only exists if you filled both fields.
// Una marca y un color de fondo nuevos en cada ejecución, que solo recibe quien carga la
// página: un snapshot que no trae la marca, o una captura que no es de ese color, no salen
// de esta página.
const token = randomBytes(4).toString('hex');
const colour: Rgb = [randomInt(40, 216), randomInt(40, 216), randomInt(40, 216)];
const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Viajes Sur ${token}</title><style>html,body{background:rgb(${colour.join(',')})}</style>${body}`;

// Lo que el navegador pidió de verdad: ruta y si lo pidió un navegador (no un fetch de Node).
// El User-Agent se puede imitar desde el código del intento; en Linux además se mira qué
// proceso abrió la conexión, y si no es un navegador no cuenta.
const seen: Array<{ url: string; browser: boolean; outsider: boolean }> = [];
const owner = new WeakMap<Socket, Promise<boolean | null>>();
const server = createServer(async (req, res) => {
  const url = req.url ?? '/';
  const ua = /Mozilla\//.test(req.headers['user-agent'] ?? '');
  const who = await owner.get(req.socket);
  seen.push({ url, browser: countsAsBrowser(ua, who, lookupWorks), outsider: who === false });
  if (url.startsWith('/evento?')) {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      page(`<h1>Viajes Sur</h1>
        <label>Origen <input id="o" role="combobox" value=""></label>
        <ul id="so" role="listbox" hidden></ul>
        <label>Destino <input id="d" role="combobox" value=""></label>
        <ul id="sd" role="listbox" hidden></ul>
        <button id="go" disabled>Buscar</button>
        <script>
          // Lo que pasa de verdad en el navegador vuelve al servidor de la sonda: los checks
          // se juzgan con esto y no solo con lo que el código del intento dice que pasó.
          const beacon = (q) => fetch('/evento?' + q, { keepalive: true }).catch(() => {});
          const data = {
            o: ['(TODAS)', 'Sevilla', 'Sevilla-Santa Justa', 'Cordoba'],
            d: ['(TODAS)', 'Malaga', 'Malaga-La Rosaleda', 'Granada'],
          };
          for (const [id, key] of [['o','o'], ['d','d']]) {
            const input = document.getElementById(id);
            const list = document.getElementById(key === 'o' ? 'so' : 'sd');
            input.addEventListener('focus', () => beacon('foco=' + id));
            input.addEventListener('input', () => {
              list.hidden = true;
              // The panel paints late. This is what broke the real run.
              setTimeout(() => {
                list.innerHTML = data[key]
                  .filter((v) => v.toLowerCase().startsWith(input.value.toLowerCase()))
                  .map((v) => '<li role="option">' + v + '</li>')
                  .join('');
                list.hidden = false;
                beacon('panel=' + id);
              }, 450);
            });
            list.addEventListener('click', (e) => {
              const li = e.target.closest('li');
              if (!li) return;
              input.value = li.textContent ?? '';
              list.hidden = true;
              const filled = document.getElementById('o').value && document.getElementById('d').value;
              document.getElementById('go').disabled = !filled;
              beacon('c=' + id + '&v=' + encodeURIComponent(input.value) + (filled ? '&go=1' : ''));
            });
          }
        </script>`),
    );
    return;
  }
  if (url.startsWith('/resultado')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const q = new URL(url, 'http://x').searchParams;
    res.end(
      page(
        `<h1>Resultado</h1><p id="echo">${q.get('o')} &rarr; ${q.get('d')}</p>
         <a href="/">Volver</a>`,
      ),
    );
    return;
  }
  if (url.startsWith('/inspirate')) {
    // A deep URL guessed from memory: the real run burned a turn on exactly this.
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end(page('<h1>No encontrado</h1>'));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page('<p>ok</p>'));
});

// Si el sistema sabe decir de quién es una conexión, solo cuenta la que se demuestra del
// navegador; una cuyo dueño ya no está (abre, escribe y se cierra) no demuestra nada.
const lookupWorks = await ownerLookupWorks(
  async (c, s) => (await connectionOwnerAny(c, s)).browser,
);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
// Un solo navegador, el que lanzó el agente: si habla un segundo (lanzado aparte por el
// código del intento para mandar avisos), ese no cuenta y la sonda lo nota.
const roots = new Set<number>();
let firstRoot: number | undefined;
server.on('connection', (socket: Socket) => {
  owner.set(
    socket,
    connectionOwnerAny(socket.remotePort ?? 0, port, { agentPid: agent.pid }).then(
      (v) => {
        if (v.browser && v.root !== undefined) {
          firstRoot ??= v.root;
          roots.add(v.root);
          if (v.root !== firstRoot) return false;
        }
        return v.browser;
      },
      () => null,
    ),
  );
});
const base = `http://127.0.0.1:${port}`;

// The agent: the candidate's BrowserService in its own process. Its standard output goes
// nowhere and its errors come back prefixed, so nothing it prints can look like a check.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const agent = spawn(
  process.execPath,
  [
    join(root, 'node_modules', 'vite-node', 'vite-node.mjs'),
    join(root, 'evolve', 'probe-agent.ts'),
  ],
  {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'advanced',
    windowsHide: true,
  },
);
agent.stderr?.setEncoding('utf8');
agent.stderr?.on('data', (d: string) => {
  for (const l of d.split('\n')) if (l.trim()) process.stderr.write(`[agente] ${l}\n`);
});
type Reply = { id?: number; ready?: boolean; ok?: boolean; value?: unknown; error?: string };
const pending = new Map<number, (r: Reply) => void>();
let seq = 0;
const ready = new Promise<void>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('el agente de la sonda no arrancó')), 180_000);
  agent.on('message', (m: Reply) => {
    if (m?.ready) {
      clearTimeout(t);
      resolve();
      return;
    }
    const done = typeof m?.id === 'number' ? pending.get(m.id) : undefined;
    if (done && m.id !== undefined) {
      pending.delete(m.id);
      done(m);
    }
  });
  agent.on('exit', (code) => {
    clearTimeout(t);
    reject(new Error(`el agente de la sonda terminó (${String(code)})`));
    for (const done of pending.values())
      done({ ok: false, error: 'el agente de la sonda terminó' });
    pending.clear();
  });
});
ready.catch(() => {});
async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  await ready;
  const r = await new Promise<Reply>((resolve) => {
    const id = ++seq;
    const t = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `${method}: sin respuesta del agente` });
    }, 120_000);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    agent.send({ id, method, args });
  });
  if (!r.ok) throw new Error(r.error ?? `${method} falló`);
  return r.value as T;
}
const service = {
  open: (s: string, url: string) => call<{ url: string; status?: number | null }>('open', s, url),
  snapshot: (s: string) => call<string>('snapshot', s),
  execJs: (s: string, code: string) => call<{ text: string }>('execJs', s, code),
  screenshot: (s: string) => call<{ data: string | { length: number } }>('screenshot', s),
  closeAll: () => call<void>('closeAll'),
};

const scope = 'generic-flow';
let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  process.stdout.write(`${ok ? 'PASA' : 'FALLA'}  ${label}${extra ? ` — ${extra}` : ''}\n`);
  if (!ok) failures++;
};
// ¿Pidió el navegador algo así? Los avisos de la página llegan un poco después.
const saw = async (pred: (url: string) => boolean, ms = 3000): Promise<boolean> => {
  const end = Date.now() + ms;
  for (;;) {
    if (seen.some((r) => r.browser && pred(r.url))) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
};
// Nadie más que el navegador ha hablado con el servidor (si el sistema lo puede saber).
const untouched = () => !seen.some((r) => r.outsider);
const ev = (q: string) => (url: string) => url.startsWith('/evento?') && url.includes(q);

try {
  // 1. The deep URL that a memory-guess produces must not cost the turn.
  const guessed = await service.open(scope, `${base}/inspirate/experiencias/rio`);
  check(
    'la URL adivinada con 404 no quema el turno',
    guessed.url.endsWith('/') &&
      !guessed.url.includes('inspirate') &&
      (await saw((u) => u.startsWith('/inspirate'))) &&
      (await saw((u) => u === '/')),
    `-> ${guessed.url} (status ${String(guessed.status)})`,
  );

  // 2. Snapshot must show the fields AND their current values, so the model can
  //    tell that a field silently kept its default.
  const snap = await service.snapshot(scope);
  check(
    'el snapshot lista los campos',
    /origen/i.test(snap) && snap.includes(token) && untouched(),
    `len=${snap.length} head=${snap.slice(0, 200)}`,
  );

  // 3. The late autocomplete, driven end to end with one call.
  const picked = await service.execJs(
    scope,
    `const o = page.locator('#o');
     await o.click();
     return 'ok';`,
  );
  check(
    'el campo recibe foco',
    !picked.text.startsWith('error') && (await saw(ev('foco=o'))),
    picked.text,
  );

  // With the panel open, the scan has to say so. This is the fact that decides the next
  // action, so it is checked while it is true rather than on the empty page.
  const opened = await service.execJs(
    scope,
    `await page.evaluate(async () => {
       const input = document.getElementById('o');
       input.focus();
       input.value = 'Sevi';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       // The panel paints 450ms after the keystroke, which is the whole point of the
       // fixture: a snapshot taken too early sees a closed field and reports nothing.
       // Waiting inside the page keeps the timing deterministic.
       await new Promise((r) => setTimeout(r, 700));
     });
     return 'ok';`,
  );
  check(
    'el desplegable se abre tras la latencia real',
    !opened.text.includes('error') && (await saw(ev('panel=o'))),
    opened.text.slice(0, 80),
  );
  const snapOpen = await service.snapshot(scope);
  check(
    'el snapshot avisa de los desplegables abiertos',
    /sugerencias abiertas|ATENCION/i.test(snapOpen) && snapOpen.includes(token) && untouched(),
    snapOpen.split('\n').slice(0, 3).join(' | ').slice(0, 160),
  );

  const from = await service.execJs(
    scope,
    `const r = await page.evaluate(() => {
       const input = document.getElementById('o');
       input.focus();
       input.value = 'Sevi';
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return 'typed';
     });
     // The panel needs ~450 ms to paint. Poll until the first option exists.
     try { await page.locator('#so li').first().waitFor({ state: 'visible', timeout: 4000 }); }
     catch (e) { return { error: 'el panel no apareció', r }; }
     return await page.evaluate(() => {
       const list = document.getElementById('so');
       const opts = [...list.querySelectorAll('li')].map((li) => li.textContent);
       const exact = opts.find((t) => t === 'Sevilla') ?? opts[0];
       list.querySelector('li').click();
       return { opts, chose: exact, value: document.getElementById('o').value };
     });`,
  );
  check(
    'las sugerencias tardias se leen y se eligen',
    !from.text.includes('error') &&
      !from.text.includes('el panel no apareció') &&
      (await saw(ev('c=o&v=Sevilla'))),
    from.text.slice(0, 120),
  );

  // 4. Reading the value back is what tells the agent the field really took it.
  const readBack = await service.execJs(
    scope,
    `return await page.evaluate(() => ({
       origen: document.getElementById('o').value,
       goDisabled: document.getElementById('go').disabled,
     }));`,
  );
  check(
    'el valor del campo se puede releer',
    readBack.text.includes('Sevilla') && (await saw(ev('c=o&v=Sevilla'))),
    readBack.text.slice(0, 120),
  );

  // 5. And the same for the destination: fill, wait, read, verify.
  const dest = await service.execJs(
    scope,
    `await page.evaluate(() => {
       const input = document.getElementById('d');
       input.focus();
       input.value = 'Mala';
       input.dispatchEvent(new Event('input', { bubbles: true }));
     });
     try { await page.locator('#sd li').first().waitFor({ state: 'visible', timeout: 4000 }); }
     catch (e) { return { error: 'panel destino no apareció' }; }
     return await page.evaluate(() => {
       const list = document.getElementById('sd');
       const opts = [...list.querySelectorAll('li')].map((li) => li.textContent);
       const exact = opts.find((t) => t === 'Malaga') ?? opts[0];
       list.querySelector('li').click();
       return { opts, chose: exact, destino: document.getElementById('d').value,
                goDisabled: document.getElementById('go').disabled };
     });`,
  );
  check(
    'el segundo desplegable tambien funciona',
    !dest.text.includes('error') &&
      !dest.text.includes('no apareció') &&
      (await saw(ev('c=d&v=Malaga'))),
    dest.text.slice(0, 140),
  );
  check(
    'el boton se habilita solo cuando ambos campos estan puestos',
    dest.text.includes('goDisabled: false') && (await saw(ev('go=1'))),
    dest.text.slice(0, 140),
  );

  // 6. Screenshot with send=true must hand the bytes back so the channel can post them.
  const shot = await service.screenshot(scope);
  const share = typeof shot.data === 'string' ? pngColourShare(shot.data, colour) : null;
  check(
    'la captura devuelve bytes enviables',
    shot.data.length > 1000 && share !== null && share > 0.3 && untouched(),
    `${shot.data.length} b64, ${share === null ? 'no es un PNG legible' : `${Math.round(share * 100)}% del color de la página`}`,
  );
} finally {
  await service.closeAll().catch(() => {});
  agent.kill();
  server.close();
}

process.stdout.write(failures === 0 ? '\nFLUJO GENERICO OK\n' : `\n${failures} PASO(S) FALLARON\n`);
process.exit(failures === 0 ? 0 : 1);

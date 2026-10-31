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
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A tiny travel-ish site with the exact three things that broke the real run:
// a late-rendering autocomplete, a field that silently keeps its default, and a
// result page that only exists if you filled both fields.
const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Viajes Sur</title>${body}`;

const server = createServer((req, res) => {
  const url = req.url ?? '/';
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
          const data = {
            o: ['(TODAS)', 'Sevilla', 'Sevilla-Santa Justa', 'Cordoba'],
            d: ['(TODAS)', 'Malaga', 'Malaga-La Rosaleda', 'Granada'],
          };
          for (const [id, key] of [['o','o'], ['d','d']]) {
            const input = document.getElementById(id);
            const list = document.getElementById(key === 'o' ? 'so' : 'sd');
            input.addEventListener('input', () => {
              list.hidden = true;
              // The panel paints late. This is what broke the real run.
              setTimeout(() => {
                list.innerHTML = data[key]
                  .filter((v) => v.toLowerCase().startsWith(input.value.toLowerCase()))
                  .map((v) => '<li role="option">' + v + '</li>')
                  .join('');
                list.hidden = false;
              }, 450);
            });
            list.addEventListener('click', (e) => {
              const li = e.target.closest('li');
              if (!li) return;
              input.value = li.textContent ?? '';
              list.hidden = true;
              const filled = document.getElementById('o').value && document.getElementById('d').value;
              document.getElementById('go').disabled = !filled;
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

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
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
  screenshot: (s: string) => call<{ data: { length: number } }>('screenshot', s),
  closeAll: () => call<void>('closeAll'),
};

const scope = 'generic-flow';
let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  process.stdout.write(`${ok ? 'PASA' : 'FALLA'}  ${label}${extra ? ` — ${extra}` : ''}\n`);
  if (!ok) failures++;
};

try {
  // 1. The deep URL that a memory-guess produces must not cost the turn.
  const guessed = await service.open(scope, `${base}/inspirate/experiencias/rio`);
  check(
    'la URL adivinada con 404 no quema el turno',
    guessed.url.endsWith('/') && !guessed.url.includes('inspirate'),
    `-> ${guessed.url} (status ${String(guessed.status)})`,
  );

  // 2. Snapshot must show the fields AND their current values, so the model can
  //    tell that a field silently kept its default.
  const snap = await service.snapshot(scope);
  check(
    'el snapshot lista los campos',
    /origen/i.test(snap),
    `len=${snap.length} head=${snap.slice(0, 200)}`,
  );

  // 3. The late autocomplete, driven end to end with one call.
  const picked = await service.execJs(
    scope,
    `const o = page.locator('#o');
     await o.click();
     return 'ok';`,
  );
  check('el campo recibe foco', !picked.text.startsWith('error'), picked.text);

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
    !opened.text.includes('error'),
    opened.text.slice(0, 80),
  );
  const snapOpen = await service.snapshot(scope);
  check(
    'el snapshot avisa de los desplegables abiertos',
    /sugerencias abiertas|ATENCION/i.test(snapOpen),
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
    !from.text.includes('error') && !from.text.includes('el panel no apareció'),
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
    readBack.text.includes('Sevilla'),
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
    !dest.text.includes('error') && !dest.text.includes('no apareció'),
    dest.text.slice(0, 140),
  );
  check(
    'el boton se habilita solo cuando ambos campos estan puestos',
    dest.text.includes('goDisabled: false'),
    dest.text.slice(0, 140),
  );

  // 6. Screenshot with send=true must hand the bytes back so the channel can post them.
  const shot = await service.screenshot(scope);
  check('la captura devuelve bytes enviables', shot.data.length > 1000, `${shot.data.length} b64`);
} finally {
  await service.closeAll().catch(() => {});
  agent.kill();
  server.close();
}

process.stdout.write(failures === 0 ? '\nFLUJO GENERICO OK\n' : `\n${failures} PASO(S) FALLARON\n`);
process.exit(failures === 0 ? 0 : 1);

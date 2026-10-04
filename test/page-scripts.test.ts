import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/browser/service.js';

/**
 * The two ways the page-side code used to break, against a real page.
 *
 * Both of these only ever failed outside the production build. `tsc` emits code that
 * happens to survive the trip to the browser, while esbuild (which tsx and vitest use,
 * with keepNames on) rewrites nested declarations to dodge collisions and appends
 * `__name(fn, "fn")` calls that reference a helper which does not exist in the page.
 * Every snapshot then died with `ReferenceError`, and the daemon carried on serving
 * snapshots it had never actually produced.
 *
 * The page scripts therefore live in plain .js, read at runtime and installed as a
 * script tag. These tests are what stops that from quietly regressing into a build step
 * nobody runs.
 */

/** A page with a late autocomplete, so "did the snapshot see it" is a real question. */
const PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Viajes</title>
<style>body{font-family:system-ui;margin:20px} #panel{display:none;border:1px solid #999;width:280px}</style>
</head><body>
  <h1>Buscar</h1>
  <label>Origen <input id="o" role="combobox" value=""></label>
  <ul id="so" role="listbox" hidden></ul>
  <button id="go" disabled>Buscar</button>
  <script>
    const list = document.getElementById('so');
    const input = document.getElementById('o');
    input.addEventListener('input', () => {
      list.hidden = true;
      setTimeout(() => {
        list.innerHTML = ['Sevilla', 'Sevilla-Santa Justa', 'Cordoba']
          .filter((v) => v.toLowerCase().startsWith(input.value.toLowerCase()))
          .map((v) => '<li role="option">' + v + '</li>')
          .join('');
        list.hidden = false;
      }, 450);
    });
  </script>
</body></html>`;

describe('page-side scripts reach the browser', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let service: BrowserService;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    dir = mkdtempSync(join(tmpdir(), 'pa-inpage-'));
    service = new BrowserService({
      policy: {
        // The fixture is served from 127.0.0.1, which the policy refuses unless private
        // hosts are allowed. Approving everything is fine here: nothing but localhost.
        approve: async () => true,
        allowPrivateHosts: true,
      },
      profilesDir: dir,
    });
  });

  afterAll(async () => {
    await service.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('scans the page instead of throwing ReferenceError', async () => {
    await service.open('inpage', base);
    const scan = await service.elements('inpage');
    expect(scan.title).toBe('Viajes');
    expect(scan.elements.length).toBeGreaterThan(0);
    // The fields must be addressable, which is the whole point of a snapshot.
    expect(scan.elements.some((el) => /origen/i.test(el.name))).toBe(true);
  });

  it('reports an open suggestion panel on the field it belongs to', async () => {
    await service.open('inpage-suggest', base);
    await service.execJs(
      'inpage-suggest',
      `await page.evaluate(async () => {
         const input = document.getElementById('o');
         input.focus();
         input.value = 'Sevi';
         input.dispatchEvent(new Event('input', { bubbles: true }));
         await new Promise((r) => setTimeout(r, 700));
       });`,
    );
    const snap = await service.snapshot('inpage-suggest');
    // Open first, because that is the fact that decides the next action.
    expect(snap).toMatch(/ATENCION/i);
    expect(snap).toMatch(/Sevilla/);
    // And per field, so the next action has an unambiguous target.
    expect(snap).toMatch(/ABIERTO:\d+ opciones/);
  });

  it('finds the page scripts in dist, so the built daemon can read them', () => {
    // tsc only emits .ts. Without the copy step the built daemon starts fine and then
    // fails on the first snapshot with ENOENT, which reads as a missing file rather than
    // a missing build step.
    for (const file of ['scan-page.js', 'ads-page.js']) {
      expect(existsSync(join('src', 'browser', file))).toBe(true);
      expect(existsSync(join('dist', 'browser', file))).toBe(true);
    }
  });
});

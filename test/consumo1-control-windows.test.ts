import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { watchOrPoll } from '../src/watch-or-poll.js';
import { CONTROL_POLL_MS } from '../src/windows-daemon-control.js';

// Consumo: el buzón de parada de Windows se sondeaba cada 250 ms (4 despertares por
// segundo todo el día). Ahora se entera por eventos de la carpeta y solo sondea cada 2 s
// por si se pierde un aviso; `pa stop` sigue viéndose al momento.
const root = mkdtempSync(join(tmpdir(), 'pa-consumo1-ctl-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('consumo: control de parada de Windows sin sondeo rápido', () => {
  it('el respaldo es de 2 s, no de 250 ms', () => {
    expect(CONTROL_POLL_MS).toBeGreaterThanOrEqual(1_000);
    const src = readFileSync('src/windows-daemon-control.ts', 'utf8');
    const open = src.slice(src.indexOf('export async function openWindowsDaemonControl'));
    const body = open.slice(0, open.indexOf('\n}\n'));
    expect(body).not.toMatch(/\},\s*250\)/);
    expect(body).toContain('watchOrPoll(');
  });

  it('una petición escrita en la carpeta se ve al momento, sin esperar al respaldo', async () => {
    const dir = join(root, 'a');
    mkdirSync(dir);
    let calls = 0;
    const w = watchOrPoll(dir, () => calls++, 60_000);
    try {
      expect(w.watching()).toBe(true);
      await wait(50);
      writeFileSync(join(dir, 'request.json'), '{}');
      for (let i = 0; i < 40 && calls === 0; i++) await wait(25);
      expect(calls).toBeGreaterThan(0);
    } finally {
      w.close();
    }
  });

  it('si la carpeta no se puede vigilar, el respaldo sigue llamando', async () => {
    let calls = 0;
    const w = watchOrPoll(join(root, 'no-existe'), () => calls++, 30);
    try {
      expect(w.watching()).toBe(false);
      await wait(140);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      w.close();
    }
  });

  it('tras cerrar no vuelve a llamar', async () => {
    const dir = join(root, 'b');
    mkdirSync(dir);
    let calls = 0;
    const w = watchOrPoll(dir, () => calls++, 20);
    w.close();
    writeFileSync(join(dir, 'x'), '1');
    await wait(100);
    expect(calls).toBe(0);
  });
});

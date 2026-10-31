/**
 * Primer uso en Windows: con PA_WEB_PORT y PA_WEB_TOKEN bien puestos, el panel aún
 * puede no encenderse porque otro programa (o una segunda Asistenta) tiene el
 * puerto, o porque Windows lo reserva (EACCES). Antes solo quedaba «panel web no
 * arrancó» en el log y la consola no decía nunca dónde estaba el panel.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { bootBanner, bootProblemText } from '../src/boot-notice.js';
import { panelBootFacts, panelListenProblem, panelStartPlan } from '../src/panel-doctor.js';

function listenError(port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', resolve);
    s.listen(port, '127.0.0.1', () => {
      s.close();
      resolve(null);
    });
  });
}

describe('panel: puerto ocupado o reservado', () => {
  it('un puerto ya en uso se explica en castellano llano, con otro número', async () => {
    const busy: Server = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
    const port = (busy.address() as { port: number }).port;
    try {
      const err = await listenError(port);
      expect((err as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
      const p = panelListenProblem(err, port);
      expect(p.problem).toBe('panel-ocupado');
      expect(p.message).toContain(`el puerto ${port} lo está usando otro programa`);
      expect(p.message).toContain(`PA_WEB_PORT en .env, por ejemplo a ${port + 1}`);
      expect(p.message).toContain('reinicia Asistenta');
      expect(p.message).not.toMatch(/EADDRINUSE|listen|Error/);
    } finally {
      busy.close();
    }
  });

  it('Windows reservando el puerto (EACCES) cuenta igual; lo raro manda a pa doctor', () => {
    const eacces = Object.assign(new Error('listen EACCES: permission denied'), { code: 'EACCES' });
    expect(panelListenProblem(eacces, 65535)).toMatchObject({ problem: 'panel-ocupado' });
    expect(panelListenProblem(eacces, 65535).message).toContain('por ejemplo a 8788');
    const raro = panelListenProblem(new Error('boom'), 8787);
    expect(raro.problem).toBe('panel-fallo');
    expect(raro.message).toContain('pa doctor');
    expect(raro.message).not.toContain('boom');
  });

  it('el aviso de arranque lo dice por Telegram sin jerga', () => {
    for (const p of ['panel-ocupado', 'panel-fallo'] as const) {
      const text = bootProblemText([p]);
      expect(text).toMatch(/^El panel web no se ha encendido/);
      expect(text).not.toMatch(/undefined|EADDRINUSE|EACCES/);
    }
  });

  it('arranque: la dirección solo si escucha de verdad; si falla, el problema', async () => {
    const plan = panelStartPlan({ PA_WEB_PORT: '8787', PA_WEB_TOKEN: 'x'.repeat(30) });
    const ok = await panelBootFacts(plan, Promise.resolve('http://127.0.0.1:8787'));
    expect(ok).toEqual({ url: 'http://127.0.0.1:8787', problems: [] });
    expect(bootBanner({ tv: false, computerUse: false, mail: false, panelUrl: ok.url })).toContain(
      'panel http://127.0.0.1:8787',
    );
    const busy = panelListenProblem(Object.assign(new Error('x'), { code: 'EADDRINUSE' }), 8787);
    expect(await panelBootFacts(plan, Promise.resolve(busy))).toEqual({
      problems: ['panel-ocupado'],
    });
    expect(await panelBootFacts(panelStartPlan({ PA_WEB_PORT: '8787' }))).toEqual({
      problems: ['panel-token'],
    });
    expect(await panelBootFacts(panelStartPlan({}))).toEqual({ problems: [] });
  });

  it('un panel que tarda no retrasa el arranque más de lo previsto', async () => {
    vi.useFakeTimers();
    try {
      const plan = panelStartPlan({ PA_WEB_PORT: '8787', PA_WEB_TOKEN: 'x'.repeat(30) });
      const facts = panelBootFacts(plan, new Promise<string>(() => {}), 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await facts).toEqual({ problems: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('el daemon espera al panel, lo dice en la consola y lo pasa al aviso', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain('panelStarted = startWebUi(');
    expect(src).toContain('const problem = panelListenProblem(err, panelPlan.port);');
    expect(src).toContain('process.stderr.write(`$' + '{problem.message}\\n`);');
    expect(src).toContain('panelUrl: panel.url,');
  });
});

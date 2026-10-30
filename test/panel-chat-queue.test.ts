import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type PanelChatThread, runPanelChat, type TurnOutput } from '../src/daemon/panel-chat.js';

function fakeThread(): PanelChatThread {
  return { key: 'telegram:dm:1:main', generation: 0, tail: Promise.resolve(), active: false };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('chat del panel → turno normal del daemon (paso 2)', () => {
  it('espera al turno vivo del hilo antes de correr y devuelve la respuesta', async () => {
    const thread = fakeThread();
    const live = deferred();
    thread.tail = live.promise;
    const calls: string[] = [];
    const p = runPanelChat(thread, 'hola', {
      remember: () => calls.push('remember'),
      runTurn: async (_t, text, out) => {
        calls.push(`turn:${text}`);
        out.answer('respuesta');
      },
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    live.resolve();
    await expect(p).resolves.toEqual({ text: 'respuesta' });
    expect(calls).toEqual(['remember', 'turn:hola']);
  });

  it('si el hilo se reinicia mientras espera, no corre ni se apunta y devuelve texto vacío', async () => {
    const thread = fakeThread();
    const live = deferred();
    thread.tail = live.promise;
    const calls: string[] = [];
    const p = runPanelChat(thread, 'hola', {
      remember: () => calls.push('remember'),
      runTurn: async () => {
        calls.push('turn');
      },
    });
    thread.generation++;
    live.resolve();
    await expect(p).resolves.toEqual({ text: '' });
    expect(calls).toEqual([]);
  });

  it('apunta el mensaje para /reintentar con su texto, dentro de la cola', async () => {
    const thread = fakeThread();
    const remembered: string[] = [];
    await runPanelChat(thread, 'busca vuelos', {
      remember: (t, text) => remembered.push(`${t.key}|${text}`),
      runTurn: async (_t, _text, out) => out.answer('ok'),
    });
    expect(remembered).toEqual(['telegram:dm:1:main|busca vuelos']);
  });

  it('los avisos del turno vuelven al panel tras la respuesta (no a Telegram)', async () => {
    const thread = fakeThread();
    const r = await runPanelChat(thread, 'x', {
      remember: () => {},
      runTurn: async (_t, _text, out: TurnOutput) => {
        out.note('Aviso: has alcanzado el presupuesto diario configurado.');
        out.answer('hecho');
        out.note('  ');
      },
    });
    expect(r.text).toBe('hecho\n\nAviso: has alcanzado el presupuesto diario configurado.');
  });

  it('un error del turno se propaga (el panel lo muestra)', async () => {
    const thread = fakeThread();
    await expect(
      runPanelChat(thread, 'x', {
        remember: () => {},
        runTurn: async () => {
          throw new Error('modelo caído');
        },
      }),
    ).rejects.toThrow('modelo caído');
  });

  describe('cableado en cli.ts', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const start = cli.indexOf('const runTurn = async (');
    const runTurnSrc = cli.slice(start, cli.indexOf('\n  };\n', start));

    it('el panel usa runTurn con salida propia y apunta el turno en lastTurns', () => {
      expect(cli).toMatch(/return runPanelChat\(thread, text, \{/);
      expect(cli).toMatch(
        /runTurn: \(t, said, out\) => runTurn\(t, panelInbound, said, \{ out, panel: true \}\)/,
      );
      expect(cli).toMatch(/remember: \(t, said\) =>\s*lastTurns\.remember\(t\.key/);
    });

    it('runTurn con `out` no envía nada por Telegram: respuesta, avisos, progreso y captura', () => {
      expect(start).toBeGreaterThan(0);
      expect(runTurnSrc).toMatch(/if \(out\) out\.answer\(text2\);\s*else await answer\(/);
      expect(runTurnSrc).toMatch(/if \(!out\) return say\(to, text, o\);/);
      // Ningún aviso sale directo por say(): todos pasan por tell().
      expect(runTurnSrc.match(/\bsay\(/g)).toHaveLength(1);
      expect(runTurnSrc).toMatch(
        /const typing = setInterval\(\(\) => \{\s*if \(finished \|\| out\) return;/,
      );
      expect(runTurnSrc).toMatch(
        /const status = setInterval\(\(\) => \{\s*if \(finished \|\| out\) return;/,
      );
      expect(runTurnSrc).toMatch(/if \(!out && wantsScreenshot\(inbound\.text\)\)/);
    });
  });
});

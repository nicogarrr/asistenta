import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { dictadoTecla } from '../src/dictado/prueba.js';
import type { TeclaDictado } from '../src/dictado/tipos.js';
import {
  avisarWindows,
  escritorWindows,
  scriptTecla,
  TeclaWindows,
} from '../src/dictado/windows.js';

describe('dictado: piezas de Windows (falsas)', () => {
  it('el vigilante de la tecla lleva los códigos y el PID del daemon', () => {
    const s = scriptTecla([[0x11], [0x5b, 0x5c]], 4242);
    expect(s).toContain("'17;91,92'");
    expect(s).toContain('-Id 4242');
  });

  it('lee D/U del vigilante aunque lleguen partidos, y lo para', async () => {
    let matado = false;
    const hijo = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      kill: () => {
        matado = true;
        return true;
      },
    });
    const tecla = new TeclaWindows([[0x11]], () => hijo as never);
    const visto: string[] = [];
    await tecla.start(
      () => visto.push('pulsa'),
      () => visto.push('suelta'),
    );
    hijo.stdout.write('D\r');
    hijo.stdout.write('\nU\r\n');
    await new Promise((r) => setImmediate(r));
    expect(visto).toEqual(['pulsa', 'suelta']);
    await tecla.stop();
    expect(matado).toBe(true);
  });

  it('campo de contraseña según UI Automation; escribe por el camino de Computer Use', async () => {
    const escrito: string[] = [];
    const pantalla = { type: async (t: string) => void escrito.push(t) };
    expect(await escritorWindows(async () => 'SI\r\n', pantalla).campoSeguro()).toBe(true);
    const e = escritorWindows(async () => 'NO\r\n', pantalla);
    expect(await e.campoSeguro()).toBe(false);
    await e.escribir('Hola.');
    expect(escrito).toEqual(['Hola.']);
  });

  it('solo el aviso «no» lanza pitidos aparte', () => {
    const scripts: string[] = [];
    const correr = async (s: string) => {
      scripts.push(s);
      return '';
    };
    avisarWindows('graba', correr);
    avisarWindows('no', correr);
    expect(scripts).toEqual([expect.stringContaining('Beep')]);
  });
});

describe('pa dictado tecla', () => {
  function teclaFalsa(pulsa: boolean): () => TeclaDictado {
    return () => ({
      start: async (p, s) => {
        if (pulsa) {
          p();
          s();
        }
      },
      stop: async () => {},
    });
  }
  const base = { esperar: async () => {}, plataforma: 'win32' as const };

  it('nota la tecla', async () => {
    const out: string[] = [];
    expect(await dictadoTecla({ ...base, tecla: teclaFalsa(true), out: (l) => out.push(l) })).toBe(
      0,
    );
    expect(out.at(-1)).toMatch(/^Bien: la tecla funciona/);
  });

  it('no la nota, tecla rara o fuera de Windows: lo dice claro', async () => {
    const out: string[] = [];
    const o = (l: string) => out.push(l);
    expect(await dictadoTecla({ ...base, tecla: teclaFalsa(false), out: o })).toBe(1);
    expect(
      await dictadoTecla({
        ...base,
        tecla: teclaFalsa(true),
        out: o,
        env: { PA_DICTADO_TECLA: 'ctrl' },
      }),
    ).toBe(2);
    expect(
      await dictadoTecla({ ...base, tecla: teclaFalsa(true), out: o, plataforma: 'linux' }),
    ).toBe(1);
    expect(out.filter((l) => !l.startsWith('Mantén'))).toEqual([
      expect.stringMatching(/^No he notado la tecla/),
      expect.stringMatching(/^No entiendo PA_DICTADO_TECLA «ctrl»/),
      'La tecla del dictado solo funciona en Windows.',
    ]);
  });
});

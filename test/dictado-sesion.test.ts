import { describe, expect, it } from 'vitest';
import { arrancarDictado } from '../src/dictado/arranque.js';
import { type DepsDictado, Dictado } from '../src/dictado/sesion.js';
import type { Aviso } from '../src/dictado/tipos.js';
import type { WakeCapture } from '../src/voice/wake.js';

const voz = () => Float32Array.from({ length: 8000 }, (_, i) => 0.3 * Math.sin(i / 5));

/** Todo falso: tecla, micrófono, voz y teclado. */
function montaje(o: { seguro?: boolean[]; texto?: string; micFalla?: boolean } = {}) {
  const seguro = [...(o.seguro ?? [])];
  const t = { pulsar: () => {}, soltar: () => {}, tope: () => {} };
  const escrito: string[] = [];
  const avisos: Aviso[] = [];
  const log: string[] = [];
  let enMarcha = false;
  const capture: WakeCapture = {
    start: async (onChunk) => {
      if (o.micFalla) throw new Error('sin micro');
      enMarcha = true;
      onChunk(voz());
      onChunk(voz());
    },
    stop: async () => {
      enMarcha = false;
    },
  };
  const deps: DepsDictado = {
    tecla: {
      start: async (p, s) => {
        t.pulsar = p;
        t.soltar = s;
      },
      stop: async () => {},
    },
    capture,
    transcribir: async () => o.texto ?? 'eh hola coma te llamo luego punto',
    escritor: {
      campoSeguro: async () => seguro.shift() ?? false,
      escribir: async (x) => void escrito.push(x),
    },
    avisar: (a) => avisos.push(a),
    log: (l) => log.push(l),
    temporizador: (_ms, fn) => {
      t.tope = fn;
      return () => {};
    },
  };
  const d = new Dictado(deps);
  return { d, t, escrito, avisos, log, mic: () => enMarcha };
}

describe('dictado: mantener, hablar, soltar', () => {
  it('escribe el texto limpio en la app con el foco y suelta el micro', async () => {
    const m = montaje();
    await m.d.start();
    m.t.pulsar();
    m.t.soltar();
    await m.d.enCurso;
    expect(m.escrito).toEqual(['Hola, te llamo luego.']);
    expect(m.avisos).toEqual(['graba', 'fin']);
    expect(m.mic()).toBe(false);
    expect(m.log.join(' ')).not.toMatch(/hola|llamo/i);
  });

  it('campo de contraseña al pulsar: ni graba ni escribe', async () => {
    const m = montaje({ seguro: [true] });
    await m.d.start();
    m.t.pulsar();
    m.t.soltar();
    await m.d.enCurso;
    expect(m.escrito).toEqual([]);
    expect(m.avisos).toEqual(['no']);
  });

  it('el foco pasa a una contraseña mientras habla: no escribe', async () => {
    const m = montaje({ seguro: [false, true] });
    await m.d.start();
    m.t.pulsar();
    m.t.soltar();
    await m.d.enCurso;
    expect(m.escrito).toEqual([]);
    expect(m.avisos).toEqual(['graba', 'fin', 'no']);
  });

  it('sin micrófono avisa y vuelve a estar listo', async () => {
    const m = montaje({ micFalla: true });
    await m.d.start();
    m.t.pulsar();
    m.t.soltar();
    await m.d.enCurso;
    expect(m.avisos).toEqual(['no']);
    expect(m.d.estado).toBe('quieto');
  });

  it('solo muletillas: no escribe nada', async () => {
    const m = montaje({ texto: 'eh mmm' });
    await m.d.start();
    m.t.pulsar();
    m.t.soltar();
    await m.d.enCurso;
    expect(m.escrito).toEqual([]);
  });

  it('al pasar el tope de tiempo corta y escribe lo dicho', async () => {
    const m = montaje({ texto: 'hola' });
    await m.d.start();
    m.t.pulsar();
    await m.d.enCurso;
    m.t.tope();
    await m.d.enCurso;
    expect(m.escrito).toEqual(['Hola']);
    m.t.soltar();
    await m.d.enCurso;
    expect(m.escrito).toEqual(['Hola']);
  });
});

describe('arrancarDictado', () => {
  const piezas = async () => ({
    tecla: { start: async () => {}, stop: async () => {} },
    capture: { start: async () => {}, stop: async () => {} },
    escritor: { campoSeguro: async () => false, escribir: async () => {} },
    avisar: () => {},
  });

  it('solo arranca con PA_DICTADO=1, en Windows y con una tecla que entiende', async () => {
    const log: string[] = [];
    const arranca = (env: NodeJS.ProcessEnv, plataforma: NodeJS.Platform = 'win32') =>
      arrancarDictado({ env, plataforma, piezas, log: (l) => log.push(l) });
    expect(await arranca({})).toBeNull();
    expect(log).toEqual([]);
    expect(await arranca({ PA_DICTADO: '1' }, 'linux')).toBeNull();
    expect(await arranca({ PA_DICTADO: '1', PA_DICTADO_TECLA: 'q' })).toBeNull();
    expect(log).toEqual([
      expect.stringMatching(/solo funciona en Windows/),
      expect.stringMatching(/PA_DICTADO_TECLA/),
    ]);
    expect(
      await arrancarDictado({
        env: { PA_DICTADO: '1' },
        plataforma: 'win32',
        piezas,
        escritorio: false,
      }),
    ).toBeNull();
    expect((await arranca({ PA_DICTADO: '1' }))?.estado).toBe('quieto');
  });
});

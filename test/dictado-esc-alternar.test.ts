import { describe, expect, it } from 'vitest';
import { ajustesDictado } from '../src/dictado/ajustes.js';
import { dictadoDoctorLine } from '../src/dictado/doctor.js';
import { Dictado } from '../src/dictado/sesion.js';
import type { Aviso } from '../src/dictado/tipos.js';
import { scriptTecla } from '../src/dictado/windows.js';
import type { WakeCapture } from '../src/voice/wake.js';

const voz = () => Float32Array.from({ length: 8000 }, (_, i) => 0.3 * Math.sin(i / 5));

function montaje(modo?: 'mantener' | 'alternar') {
  const t = { pulsar: () => {}, soltar: () => {}, cancelar: () => {} };
  const escrito: string[] = [];
  const avisos: Aviso[] = [];
  let transcritos = 0;
  const capture: WakeCapture = {
    start: async (onChunk) => onChunk(voz()),
    stop: async () => {},
  };
  const d = new Dictado({
    tecla: {
      start: async (p, s, c) => {
        t.pulsar = p;
        t.soltar = s;
        t.cancelar = c ?? (() => {});
      },
      stop: async () => {},
    },
    capture,
    transcribir: async () => {
      transcritos++;
      return 'hola';
    },
    escritor: { campoSeguro: async () => false, escribir: async (x) => void escrito.push(x) },
    avisar: (a) => avisos.push(a),
    modo,
    temporizador: () => () => {},
  });
  return { d, t, escrito, avisos, transcritos: () => transcritos };
}

describe('dictado: Esc descarta y modo alternar (ideas de pi-voice)', () => {
  it('Esc mientras graba: no transcribe ni escribe, y al soltar no pasa nada', async () => {
    const m = montaje();
    await m.d.start();
    m.t.pulsar();
    m.t.cancelar();
    m.t.soltar();
    await m.d.enCurso;
    expect(m.transcritos()).toBe(0);
    expect(m.escrito).toEqual([]);
    expect(m.avisos).toEqual(['graba', 'fin']);
    expect(m.d.estado).toBe('quieto');
  });

  it('Esc sin estar grabando no hace nada', async () => {
    const m = montaje();
    await m.d.start();
    m.t.cancelar();
    await m.d.enCurso;
    expect(m.avisos).toEqual([]);
  });

  it('alternar: soltar no termina; la segunda pulsación sí', async () => {
    const m = montaje('alternar');
    await m.d.start();
    m.t.pulsar();
    m.t.soltar();
    await m.d.enCurso;
    expect(m.d.estado).toBe('grabando');
    m.t.pulsar();
    m.t.soltar();
    await m.d.enCurso;
    expect(m.escrito).toEqual(['Hola']);
  });

  it('PA_DICTADO_MODO y la línea de pa doctor', () => {
    expect(ajustesDictado({}).modo).toBe('mantener');
    expect(ajustesDictado({ PA_DICTADO_MODO: 'Alternar' }).modo).toBe('alternar');
    const env = { PA_DICTADO: '1', PA_DICTADO_MODO: 'alternar' };
    expect(dictadoDoctorLine(env, 'win32')).toMatch(
      /pulsa ctrl\+win para empezar y otra vez para terminar; Esc descarta/,
    );
  });

  it('el vigilante avisa de Esc (código 27)', () => {
    expect(scriptTecla([[0x11]], 1)).toContain('GetAsyncKeyState(27)');
  });
});

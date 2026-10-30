import { describe, expect, it, vi } from 'vitest';
import { audioCommand, PRUEBA_TELE_USAGE, parsePruebaTele } from '../src/audio/prueba-tele.js';
import type { TvCastResult } from '../src/audio/tv-cast.js';

// `pa audio prueba-tele` se usa a mano en el PC de Nico: `--via=launcher`, `--help`
// o un fallo antes de llegar a la tele no pueden acabar en «No puedo leer --help»
// ni en una traza sin capturar.
function deps(cast: (f: string) => Promise<TvCastResult>) {
  const lines: string[] = [];
  const copies: string[] = [];
  const discarded: string[] = [];
  return {
    lines,
    copies,
    discarded,
    d: {
      copyToTemp: vi.fn(async (f: string) => {
        copies.push(f);
        return `/tmp/copia-${copies.length}.mp3`;
      }),
      cast: vi.fn(cast),
      print: (l: string) => lines.push(l),
      sleep: async () => {},
      discard: (f: string) => discarded.push(f),
      fetchWaitMs: 0,
    },
  };
}

describe('parsePruebaTele', () => {
  it('acepta --via=launcher igual que --via launcher', () => {
    expect(parsePruebaTele(['nota.mp3', '--via=launcher'])).toEqual({
      file: 'nota.mp3',
      only: 'launcher',
    });
    expect(parsePruebaTele(['--via=glasshouse', 'nota.mp3'])).toEqual({
      file: 'nota.mp3',
      only: 'glasshouse',
    });
  });

  it('--via=desconocida es un error de uso, no un fichero', () => {
    const r = parsePruebaTele(['nota.mp3', '--via=chromecast']);
    expect(r).toEqual({ error: expect.stringContaining('Vía desconocida «chromecast»') });
  });

  it('una opción desconocida no se toma como fichero', () => {
    expect(parsePruebaTele(['--verbose', 'nota.mp3'])).toEqual({
      error: expect.stringContaining('Opción desconocida «--verbose»'),
    });
  });

  it('tras «--» un nombre que empieza por guion es el fichero', () => {
    expect(parsePruebaTele(['--', '-raro.mp3'])).toEqual({ file: '-raro.mp3', only: undefined });
  });
});

describe('audioCommand', () => {
  it('--help y -h imprimen el uso y salen con 0 sin copiar nada', async () => {
    for (const flag of ['--help', '-h']) {
      const t = deps(async () => ({ ok: false, message: 'no' }));
      expect(await audioCommand(['prueba-tele', flag], t.d)).toBe(0);
      expect(t.lines).toEqual([PRUEBA_TELE_USAGE]);
      expect(t.d.copyToTemp).not.toHaveBeenCalled();
    }
  });

  it('--via=launcher llega al envío como vía única', async () => {
    const t = deps(async () => ({ ok: false, message: 'la tele no responde' }));
    expect(await audioCommand(['prueba-tele', 'nota.mp3', '--via=launcher'], t.d)).toBe(1);
    expect(t.copies).toEqual(['nota.mp3']);
    expect(t.d.cast).toHaveBeenCalledWith('/tmp/copia-1.mp3', 'launcher');
  });

  it('si el envío lanza, avisa en castellano, borra la copia y sale con 1', async () => {
    const t = deps(async () => {
      throw new Error('vault bloqueado');
    });
    expect(await audioCommand(['prueba-tele', 'nota.mp3'], t.d)).toBe(1);
    expect(t.discarded).toEqual(['/tmp/copia-1.mp3']);
    expect(t.lines.at(-1)).toBe('✗ No he podido mandar el audio a la tele: vault bloqueado');
  });
});

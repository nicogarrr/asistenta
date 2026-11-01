import { describe, expect, it } from 'vitest';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import { TvUnreachableError } from '../src/tv/lgtv.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { resolveScene, TV_SCENES } from '../src/tv/scenes.js';
import type { TvStatus } from '../src/tv/status.js';

const status = (power: TvStatus['power']): TvStatus => ({
  reachable: power !== 'apagada o fuera de red',
  power,
  powerState: null,
  appId: null,
  showing: null,
  input: null,
  volume: null,
  muted: null,
  checkedAt: '2026-10-30T21:00:00.000Z',
});

function deps(over: Partial<TvToolDeps> = {}) {
  const calls: string[] = [];
  const d: TvToolDeps = {
    shot: async () => ({ image: Buffer.alloc(1), mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'x', category: [] }),
    apps: async () => [],
    launch: async (id) => void calls.push(`launch:${id}`),
    key: async (n) => void calls.push(`key:${n}`),
    toast: async (m) => void calls.push(`toast:${m}`),
    power: async (on) => void calls.push(`power:${on}`),
    ghControl: async (a, v) => void calls.push(`gh:${a}:${String(v)}`),
    saveFrame: () => '',
    getState: () => null,
    setState: () => {},
    ...over,
  };
  return { d, calls };
}
type R = { content: Array<{ text?: string }>; details: Record<string, unknown> };
const run = (d: TvToolDeps, args: Record<string, unknown>) =>
  createTvTool(d).execute('id', args as never) as unknown as Promise<R>;
const text = (r: R) => r.content.map((c) => c.text ?? '').join(' ');

describe('modo cine', () => {
  it('tele apagada: enciende, quita silencio, volumen 20, abre Netflix y avisa, en ese orden', async () => {
    const { d, calls } = deps({ status: async () => status('en reposo') });
    const r = await run(d, { action: 'scene', scene: 'cine', appId: 'Netflix' });
    expect(calls).toEqual([
      'power:true',
      'gh:mute:false',
      'gh:volume:20',
      'launch:netflix',
      'toast:Modo cine activado. Disfruta de la peli.',
    ]);
    expect(text(r)).toMatch(
      /^Modo cine listo:\n- encender la tele: hecho\n- quitar el silencio: hecho\n- volumen a 20: hecho\n- abrir Netflix: hecho\n- aviso en pantalla: hecho$/,
    );
    expect(r.details).toMatchObject({ scene: 'cine', complete: true, failed: 0 });
  });

  it('ya encendida: no reenvia el encendido; level personalizado', async () => {
    const { d, calls } = deps({ status: async () => status('encendida') });
    const r = await run(d, { action: 'scene', scene: 'cine', level: 12 });
    expect(calls).toEqual([
      'gh:mute:false',
      'gh:volume:12',
      'toast:Modo cine activado. Disfruta de la peli.',
    ]);
    expect(text(r)).toContain('- encender la tele: omitido (ya estaba encendida)');
  });

  it('sin Glasshouse: volumen y silencio se omiten, el resto sigue', async () => {
    const { d, calls } = deps({ ghControl: undefined });
    const r = await run(d, { action: 'scene', scene: 'modo cine' });
    expect(calls).toEqual(['power:true', 'toast:Modo cine activado. Disfruta de la peli.']);
    expect(text(r)).toContain('- volumen a 20: omitido (sin Glasshouse configurado)');
    expect(r.details.failed).toBe(0);
  });

  it('si no enciende, para: no manda ordenes a una tele apagada', async () => {
    const { d, calls } = deps({
      power: async () => {
        throw new TvUnreachableError(
          'No se pudo conectar con la TV en 192.168.1.237 (wss://3001).',
        );
      },
    });
    const r = await run(d, { action: 'scene', scene: 'cine', appId: 'netflix' });
    expect(calls).toEqual([]);
    expect(text(r)).toMatch(/^No he podido completar el modo cine: la tele no se encendio/);
    expect(text(r)).toMatch(/encender la tele: FALLO \(No llego a la tele/);
    expect(r.details).toMatchObject({ complete: false, failed: 1 });
  });

  it('un paso intermedio que falla se informa y la rutina sigue', async () => {
    const { d, calls } = deps({
      launch: async () => {
        throw new Error('La TV rechazo system.launcher/launch: app not found');
      },
    });
    const r = await run(d, { action: 'scene', scene: 'cine', appId: 'netflix' });
    expect(calls.at(-1)).toBe('toast:Modo cine activado. Disfruta de la peli.');
    expect(text(r)).toMatch(/^Modo cine listo con 1 paso fallido:/);
    expect(text(r)).toContain('- abrir netflix: FALLO');
  });

  it('validacion: rutina desconocida y level fuera de rango', async () => {
    const { d, calls } = deps();
    await expect(run(d, { action: 'scene', scene: 'fiesta' })).rejects.toThrow(
      /necesita scene: cine/,
    );
    await expect(run(d, { action: 'scene', scene: 'cine', level: 300 })).rejects.toThrow(
      /entero 0-100/,
    );
    expect(calls).toEqual([]);
  });

  it('por orden natural: "pon el modo cine con Netflix"', async () => {
    expect(parseTvCommand('pon el modo cine con Netflix')).toEqual({
      action: 'scene',
      scene: 'cine',
      appId: 'netflix',
    });
    expect(parseTvCommand('noche de peli')).toEqual({ action: 'scene', scene: 'cine' });
    const { d, calls } = deps({ status: async () => status('encendida') });
    const r = await run(d, { action: 'command', text: 'modo cine con YouTube' });
    expect(calls).toContain('launch:youtube.leanback.v4');
    expect(text(r)).toMatch(/^Entendido: activar el modo cine con YouTube\./);
  });

  it('catalogo y alias', () => {
    expect(resolveScene('Película')).toBe('cine');
    expect(resolveScene('fiesta')).toBeNull();
    expect(TV_SCENES.cine?.build({}).map((s) => s.action)).toEqual([
      'power',
      'mute',
      'volume',
      'toast',
    ]);
  });
});

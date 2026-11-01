/**
 * Extras de Glasshouse en las rutinas (decisión de Nico, 30-oct-2026):
 * «apagar todo» cierra antes la app abierta y «modo noche» pone la imagen
 * oscura. Los dos son opcionales: sin Glasshouse se omiten y si fallan se
 * ignoran. Solo tele simulada.
 */
import { describe, expect, it } from 'vitest';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import { NOCHE_PICTURE_MODE, TV_SCENES } from '../src/tv/scenes.js';

function deps(over: Partial<TvToolDeps> = {}, failGh: string[] = []) {
  const calls: string[] = [];
  const d: TvToolDeps = {
    shot: async () => ({ image: Buffer.alloc(1), mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'netflix', category: [] }),
    apps: async () => [],
    launch: async (id) => void calls.push(`launch:${id}`),
    key: async (n) => void calls.push(`key:${n}`),
    toast: async (m) => void calls.push(`toast:${m}`),
    power: async (on) => void calls.push(`power:${on}`),
    ghControl: async (a, v) => {
      if (failGh.includes(a)) throw new Error(`La tele rechazo ${a}: no.`);
      calls.push(`gh:${a}:${String(v)}`);
    },
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
const gh = (calls: string[]) =>
  calls.filter((c) => c.startsWith('gh:') && !c.startsWith('gh:toast'));

describe('«apagar todo» cierra la app abierta antes de apagar', () => {
  it('cierra la app en primer plano y luego apaga', async () => {
    const { d, calls } = deps();
    const r = await run(d, { action: 'scene', scene: 'apagar todo' });
    const close = calls.indexOf('gh:closeApp:netflix');
    expect(close).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('power:false')).toBeGreaterThan(close);
    expect(text(r)).not.toMatch(/FALLO|fallid/);
  });

  it.each(['com.webos.app.home', 'com.webos.app.launcher', ''])(
    'sin app abierta («%s») no cierra nada y apaga',
    async (appId) => {
      const { d, calls } = deps({ foreground: async () => ({ appId, category: [] }) });
      await run(d, { action: 'scene', scene: 'apagar-todo' });
      expect(gh(calls)).toEqual([]);
      expect(calls).toContain('power:false');
    },
  );

  it('si cerrar falla, se ignora y apaga igual', async () => {
    const { d, calls } = deps({}, ['closeApp']);
    const r = await run(d, { action: 'scene', scene: 'apagar-todo' });
    expect(calls).toContain('power:false');
    expect(text(r)).not.toMatch(/FALLO|fallid/);
  });

  it('si no se puede leer la app abierta, apaga igual', async () => {
    const { d, calls } = deps({ foreground: async () => Promise.reject(new Error('sin red')) });
    await run(d, { action: 'scene', scene: 'apagar-todo' });
    expect(calls).toContain('power:false');
  });

  it('sin Glasshouse: no intenta cerrar y apaga', async () => {
    const { d, calls } = deps({ ghControl: undefined });
    await run(d, { action: 'scene', scene: 'apagar-todo' });
    expect(calls).toContain('power:false');
    expect(gh(calls)).toEqual([]);
  });
});

describe('«modo noche» pone la imagen oscura', () => {
  it('modo de imagen eco además del volumen bajo', async () => {
    expect(NOCHE_PICTURE_MODE).toBe('eco');
    const { d, calls } = deps();
    await run(d, { action: 'scene', scene: 'modo noche' });
    expect(gh(calls)).toEqual(['gh:volume:8', 'gh:pictureMode:eco']);
  });

  it('si la imagen falla, se ignora: sin «FALLO» y el aviso sale', async () => {
    const { d, calls } = deps({}, ['pictureMode']);
    const r = await run(d, { action: 'scene', scene: 'noche' });
    expect(gh(calls)).toEqual(['gh:volume:8']);
    expect(text(r)).not.toMatch(/FALLO|fallid/);
    expect(calls.some((c) => c.includes('Modo noche'))).toBe(true);
  });

  it('el modo cine no toca la imagen ni cierra apps', () => {
    const steps = TV_SCENES.cine?.build({ appId: 'netflix' }) ?? [];
    expect(steps.some((s) => s.action === 'picture' || s.action === 'closeForeground')).toBe(false);
  });
});

describe('action=picture (para volver a la imagen de antes)', () => {
  it('«pon la imagen en estándar» → pictureMode standard', async () => {
    const { d, calls } = deps();
    const r = await run(d, { action: 'picture', pictureMode: 'standard' });
    expect(calls).toEqual(['gh:pictureMode:standard']);
    expect(text(r)).toContain('standard');
  });

  it.each(['', 'eco; rm', 'x'])(
    'modo no válido «%s» → error, no manda nada',
    async (pictureMode) => {
      const { d, calls } = deps();
      await expect(run(d, { action: 'picture', pictureMode })).rejects.toThrow(/pictureMode/);
      expect(calls).toEqual([]);
    },
  );
});

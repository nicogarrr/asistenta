import { describe, expect, it, vi } from 'vitest';
import { parseTvCommand } from '../src/tv/natural.js';
import {
  createTvPressGuard,
  TV_BUTTONS,
  TV_REPEAT_IGNORED,
  tvButtonCommand,
  tvButtons,
} from '../src/tv/tv-chat-command.js';

describe('/tv mando: «⬅️ Atrás» y fila de modos de imagen', () => {
  it('ANTES no había botón Atrás; ahora existe y es la tecla BACK', async () => {
    const back = TV_BUTTONS.find((b) => b.id === 'back');
    expect(back?.label).toBe('⬅️ Atrás');
    expect(parseTvCommand(back?.order ?? '')).toEqual({ action: 'key', name: 'BACK' });
    const run = vi.fn(async (t: string) => `ok ${t}`);
    expect(await tvButtonCommand('tv:back', { isOwner: true, run })).toBe(`ok ${back?.order}`);
  });

  it('cada modo de imagen es un botón que el parser lee como action=picture', () => {
    const want: Record<string, string> = {
      pic_std: 'standard',
      pic_cine: 'cinema',
      pic_juego: 'game',
      pic_dep: 'sports',
      pic_viva: 'vivid',
      pic_eco: 'eco',
    };
    for (const [id, mode] of Object.entries(want)) {
      const b = TV_BUTTONS.find((x) => x.id === id);
      expect(b, id).toBeDefined();
      expect(parseTvCommand(b?.order ?? ''), id).toEqual({ action: 'picture', pictureMode: mode });
    }
  });

  it('los modos van juntos al final, en filas completas de dos (sin botón suelto)', () => {
    const ids = tvButtons().map((b) => b.action);
    const firstPic = ids.findIndex((a) => a.startsWith('tv:pic_'));
    expect(ids.slice(firstPic).every((a) => a.startsWith('tv:pic_'))).toBe(true);
    expect(firstPic % 2).toBe(0);
    expect(ids.length % 2).toBe(0);
  });

  it('un modo de imagen pulsado dos veces seguidas manda la orden una vez', async () => {
    const run = vi.fn(async () => 'ok');
    const deps = { isOwner: true, run, guard: createTvPressGuard(1000, () => 0), chatId: '7' };
    await tvButtonCommand('tv:pic_cine', deps);
    expect(await tvButtonCommand('tv:pic_cine', deps)).toBe(TV_REPEAT_IGNORED);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('otro usuario no puede pulsar Atrás ni modos', async () => {
    const run = vi.fn(async () => 'ok');
    await tvButtonCommand('tv:back', { isOwner: false, run });
    await tvButtonCommand('tv:pic_juego', { isOwner: false, run });
    expect(run).not.toHaveBeenCalled();
  });
});

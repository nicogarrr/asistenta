import { describe, expect, it } from 'vitest';
import { helpCommands } from '../src/channels/telegram-help.js';
import {
  ATAJO_TOKEN_BORRAR_MS,
  atajosInstrucciones,
  urlPanelDeBotones,
} from '../src/webui/atajo.js';

// /atajos en Telegram (Nico, 7 nov): los pasos para montar los atajos del iPhone con la
// dirección real del panel por Tailscale, sin que tenga que buscarla ni tocar el PC.

describe('/atajos', () => {
  it('sale en /help', () => {
    expect(helpCommands()).toContain('atajos');
  });

  it('saca la dirección del botón de /panel, acabada en «/»', () => {
    expect(
      urlPanelDeBotones([
        { label: '📱 Abrir panel', action: 'webapp:https://pc.tailae34cd.ts.net' },
      ]),
    ).toBe('https://pc.tailae34cd.ts.net/');
    expect(urlPanelDeBotones([{ label: 'x', action: 'webapp:https://pc.ts.net/' }])).toBe(
      'https://pc.ts.net/',
    );
    expect(urlPanelDeBotones(undefined)).toBeNull();
    expect(urlPanelDeBotones([{ label: 'x', action: 'webapp:http://pc.ts.net/' }])).toBeNull();
    expect(urlPanelDeBotones([{ label: 'x', action: 'cmd:panel' }])).toBeNull();
  });

  it('los pasos llevan la URL real de /api/atajo y los dos atajos', () => {
    const t = atajosInstrucciones('https://pc.tailae34cd.ts.net/');
    expect(t).toContain('https://pc.tailae34cd.ts.net/api/atajo');
    expect(t).toContain('Dictar texto');
    expect(t).toContain('modo = voz');
    expect(t).toContain('modo = texto');
    expect(t).toContain('Authorization');
    expect(t).toContain('10 minutos');
    // El token no va en este mensaje: va aparte y se borra solo.
    expect(t).not.toMatch(/Bearer \S/);
  });

  it('el token se borra a los 10 minutos', () => {
    expect(ATAJO_TOKEN_BORRAR_MS).toBe(600_000);
  });
});

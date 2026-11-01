import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALTAVOZ_USAGE, altavozStatusText, parseAltavozArgs } from '../src/audio/altavoz.js';
import { PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { COMPUTER_SWITCH_USAGE, computerSwitchCommand } from '../src/screen/computer-switch.js';
import { parseTriggerAdd } from '../src/triggers.js';
import { isTvOrder, TV_CHAT_USAGE, tvChatCommand } from '../src/tv/tv-chat-command.js';

// Nico (1 nov, 00:47 y 01:20): «como estamos hablando nosotros», sin «/tv apaga la
// tele» ni «/ordenador on» de ejemplo. La tele, el altavoz, el ordenador y los
// disparadores preguntan normal y la siguiente respuesta del chat completa la orden.
const cli = readFileSync('src/cli.ts', 'utf8');
const BARRA = /\/(?:tv|altavoz|ordenador|disparador|disparadores|learn)\b/;

describe('tele, altavoz, ordenador y disparadores hablan como un amigo', () => {
  it('ninguna de estas respuestas enseña un comando con barra', async () => {
    const run = async () => 'ok';
    const tv = [
      TV_CHAT_USAGE,
      await tvChatCommand('haz magia', { isOwner: true, run }),
      await tvChatCommand('apaga la tele a las 11', { isOwner: true, run }),
      await tvChatCommand('x'.repeat(201), { isOwner: true, run }),
    ];
    const altavoz = [ALTAVOZ_USAGE, ...(['pc', 'tele', 'off'] as const).map(altavozStatusText)];
    const off = { isOwner: true, enabled: () => false, set: () => {} };
    const on = { ...off, enabled: () => true };
    const ordenador = [
      COMPUTER_SWITCH_USAGE,
      computerSwitchCommand('', on),
      computerSwitchCommand('', off),
      computerSwitchCommand('off', on),
    ];
    const disparador = [parseTriggerAdd('archivo .pdf')];
    for (const t of [...tv, ...altavoz, ...ordenador]) expect(t).not.toMatch(BARRA);
    for (const r of disparador) expect(r.ok ? '' : r.error).not.toMatch(BARRA);
    for (const viejo of [
      'mientras, /altavoz pc.',
      'Grábala primero con /learn',
      'Pasa sus parámetros fijos: /disparador',
      'Lo ves con /disparadores.',
    ]) {
      expect(cli).not.toContain(viejo);
    }
  });

  it('los ejemplos de la tele son órdenes que de verdad entiende', () => {
    for (const t of ['apaga la tele', 'abre Netflix', 'volumen a 15', 'silencio', 'modo cine']) {
      expect(isTvOrder(t)).toBe(true);
      expect(TV_CHAT_USAGE).toContain(`«${t}»`);
    }
    expect(isTvOrder('¿qué tal el día?')).toBe(false);
  });

  it('/ordenador: tras el estado, «apágalo» o «enciéndelo» lo completan', () => {
    const p = new PreguntasPendientes(() => 0);
    const deps = (enabled: boolean) => ({
      isOwner: true,
      enabled: () => enabled,
      set: () => {},
      ask: (o: Parameters<PreguntasPendientes['ask']>[2]) => p.ask('c', 'ordenador', o),
    });
    expect(computerSwitchCommand('', deps(true))).toBe(
      '🖥️ Control del ordenador: ACTIVADO. Si quieres quitármelo, dime «apágalo».',
    );
    expect(p.consume('c', '¡Apágalo!')).toEqual({ name: 'ordenador', args: 'off' });
    computerSwitchCommand('', deps(true));
    expect(p.consume('c', 'enciéndelo')).toBeNull();
    computerSwitchCommand('', deps(false));
    expect(p.consume('c', 'Enciéndelo')).toEqual({ name: 'ordenador', args: 'on' });
    expect(computerSwitchCommand('???', deps(false))).toBe(COMPUTER_SWITCH_USAGE);
    expect(p.consume('c', 'apágalo')).toEqual({ name: 'ordenador', args: 'off' });
    // Ajeno al dueño: ni pregunta.
    const ajeno = { ...deps(true), isOwner: false };
    computerSwitchCommand('', ajeno);
    expect(p.consume('c', 'apágalo')).toBeNull();
  });

  it('/altavoz: entiende «por la tele», «por el PC» y «apágalo»', () => {
    expect(parseAltavozArgs('por la tele')).toEqual({ kind: 'set', mode: 'tele' });
    expect(parseAltavozArgs('Por el PC.')).toEqual({ kind: 'set', mode: 'pc' });
    expect(parseAltavozArgs('apágalo')).toEqual({ kind: 'set', mode: 'off' });
    expect(parseAltavozArgs('por ninguno')).toEqual({ kind: 'set', mode: 'off' });
    expect(parseAltavozArgs('qué tal')).toEqual({ kind: 'error' });
    expect(cli).toContain(
      "preguntas.ask(key, 'altavoz', { accepts: (t) => parseAltavozArgs(t).kind === 'set' })",
    );
  });

  it('/disparador del sin número: enseña la lista y «el 2» lo borra', () => {
    expect(cli).toContain('`¿Cuál quito? Dime su número.\\n');
    expect(cli).toContain("'No tienes disparadores que quitar.'");
    expect(cli).toContain("preguntas.ask(chatKey(inbound), 'tv', { accepts: isTvOrder })");
    expect(cli).toContain("ask: (opts) => preguntas.ask(chatKey(inbound), 'ordenador', opts)");
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUsageDays } from '../src/core/usage-format.js';
import { routeInboundControl } from '../src/daemon/inbound.js';
import { PREGUNTA_TTL_MS, PreguntasPendientes } from '../src/daemon/pregunta-pendiente.js';
import { formatReminderRows, pickReminder } from '../src/tools/reminder.js';

// Nico (1 nov, 01:20): «más natural aún, como estamos hablando nosotros». Las
// respuestas preguntan como un amigo, sin enseñar sintaxis de comandos, y la
// respuesta en texto normal completa el comando sin tener que reescribirlo.
const cli = readFileSync('src/cli.ts', 'utf8');
type Cmd = { name: string; args: string };
const parse = (text: string): Cmd | null =>
  text.startsWith('/') ? { name: text.slice(1).split(' ')[0] ?? '', args: '' } : null;

describe('pregunta pendiente: la respuesta normal completa el comando', () => {
  it('usa la respuesta una vez y con el prefijo del subcomando', () => {
    const p = new PreguntasPendientes(() => 0);
    p.ask('chat:1', 'memoria', { prefix: 'buscar ' });
    expect(p.consume('chat:1', ' el taller ')).toEqual({
      name: 'memoria',
      args: 'buscar el taller',
    });
    expect(p.consume('chat:1', 'otra cosa')).toBeNull();
  });

  it('caduca a los 10 minutos y no cruza de chat', () => {
    let now = 0;
    const p = new PreguntasPendientes(() => now);
    p.ask('chat:1', 'investiga');
    expect(p.consume('chat:2', 'aerotermia')).toBeNull();
    now = PREGUNTA_TTL_MS + 1;
    expect(p.consume('chat:1', 'aerotermia')).toBeNull();
  });

  it('no usa respuestas que no encajan', () => {
    const p = new PreguntasPendientes(() => 0);
    for (const t of ['déjalo', 'nada', '/estado', 'una\ndos', 'x'.repeat(301)]) {
      p.ask('c', 'buscar');
      expect(p.consume('c', t)).toBeNull();
    }
    p.ask('c', 'vigila', { needsUrl: true });
    expect(p.consume('c', 'la tele de mediamarkt')).toBeNull();
    p.ask('c', 'vigila', { needsUrl: true });
    expect(p.consume('c', 'https://tienda.es/tele')?.args).toBe('https://tienda.es/tele');
    p.ask('c', 'consumo', { accepts: (t) => parseUsageDays(t) !== null });
    expect(p.consume('c', '¿qué tiempo hace?')).toBeNull();
  });

  it('el enrutado: un comando anula la pregunta; el texto normal la contesta', async () => {
    const p = new PreguntasPendientes(() => 0);
    const ran: Cmd[] = [];
    const deps = {
      mailReply: async () => {},
      consumeErase: () => null,
      eraseConfirmed: async () => {},
      eraseCancelled: async () => {},
      parseCommand: parse,
      runCommand: async (_m: unknown, c: Cmd) => {
        ran.push(c);
      },
      consumeAnswer: (k: string, t: string) => p.consume(k, t),
      clearAnswer: (k: string) => p.clear(k),
    };
    p.ask('k', 'buscar');
    expect(await routeInboundControl({ text: 'presupuesto del taller' }, 'k', deps)).toBe(
      'handled',
    );
    expect(ran).toEqual([{ name: 'buscar', args: 'presupuesto del taller' }]);
    p.ask('k', 'buscar');
    await routeInboundControl({ text: '/estado' }, 'k', deps);
    expect(await routeInboundControl({ text: 'hola' }, 'k', deps)).toBe('continue');
  });

  it('/consumo entiende «de la semana», «del mes» o «los últimos 10 días»', () => {
    expect(parseUsageDays('de la semana')).toBe(7);
    expect(parseUsageDays('del mes')).toBe(30);
    expect(parseUsageDays('de hoy')).toBe(1);
    expect(parseUsageDays('los últimos 10 días')).toBe(10);
  });
});

describe('preguntas de amigo, sin sintaxis de comandos', () => {
  it('las respuestas sin datos preguntan normal', () => {
    for (const t of [
      "'¿Qué página quieres que vigile? Pásame el enlace y te aviso si cambia el precio.'",
      "'¿Qué quieres que investigue?'",
      "'¿De cuándo quieres ver el consumo? ¿De hoy, de la semana, del mes?'",
      "'¿Qué quieres que busque?'",
      "'¿Qué quieres que recuerde de ti?'",
    ]) {
      expect(cli).toContain(t);
    }
    for (const viejo of [
      'por ejemplo: /vigila',
      'Prueba /consumo hoy',
      'Por ejemplo: /buscar',
      'Por ejemplo: /perfil guardar',
      'Por ejemplo: /investiga ¿',
    ]) {
      expect(cli).not.toContain(viejo);
    }
  });

  it('recordatorios: el pie y la pregunta no enseñan comandos', () => {
    const r = pickReminder([], '');
    expect(r.ok ? '' : r.error).toBe('¿Cuál quito? Dime su número de la lista o una palabra.');
    expect(formatReminderRows([], new Date())).not.toContain('/recordatorios');
  });
});

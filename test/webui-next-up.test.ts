import { describe, expect, it } from 'vitest';
import { COMMAND_PROMPT_PREFIX } from '../src/command-routine.js';
import { GOAL_ROUTINE_PREFIX } from '../src/goals/runner.js';
import { REMINDER_ONCE_PREFIX, REMINDER_PREFIX } from '../src/tools/reminder.js';
import { etiquetaCampo } from '../src/webui/client-format.js';
import { panelNextUp, panelScopeVisible } from '../src/webui/next-up.js';

const now = new Date('2026-10-30T10:00:00Z');
const en = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
const DUENO = '42';
const PRIV = `telegram:dm:${DUENO}#main`;

type Fila = { scope: string; name: string; next: string | null; prompt: string | null };
function calcular(filas: Fila[], owner: string | undefined = DUENO) {
  const mapa = new Map(filas.map((f) => [`${f.scope}|${f.name}`, f]));
  return panelNextUp(filas, (scope, name) => mapa.get(`${scope}|${name}`), owner, now);
}

describe('panel: próximo recordatorio y rutina en Estado', () => {
  it('elige el recordatorio y la rutina más cercanos del dueño', () => {
    const r = calcular([
      { scope: PRIV, name: `${REMINDER_ONCE_PREFIX}b`, next: en(180), prompt: 'llamar al banco' },
      { scope: PRIV, name: `${REMINDER_PREFIX}a`, next: en(30), prompt: 'tomar la pastilla' },
      { scope: PRIV, name: 'resumen', next: en(600), prompt: 'resume el día' },
      { scope: 'local', name: 'copia', next: en(120), prompt: 'haz copia' },
    ]);
    expect(r.proximoRecordatorio).toMatch(/^tomar la pastilla — .+ \(en 30 min\)$/);
    expect(r.proximaRutina).toMatch(/^copia — .+ \(en 2 h\)$/);
  });

  it('marca las rutinas de comando y no cuenta las de objetivos', () => {
    const r = calcular([
      { scope: PRIV, name: `${GOAL_ROUTINE_PREFIX}x`, next: en(5), prompt: 'objetivo' },
      { scope: PRIV, name: 'backup', next: en(60), prompt: `${COMMAND_PROMPT_PREFIX}pa backup` },
    ]);
    expect(r.proximaRutina).toMatch(/^backup · comando — /);
    expect(r.proximoRecordatorio).toBeNull();
  });

  it('nunca enseña grupos ni el privado de otra persona', () => {
    const r = calcular([
      {
        scope: 'telegram:group:-100',
        name: `${REMINDER_PREFIX}g`,
        next: en(1),
        prompt: 'del grupo',
      },
      { scope: 'telegram:dm:7#main', name: `${REMINDER_PREFIX}o`, next: en(2), prompt: 'de otro' },
      { scope: 'telegram:dm:420', name: 'otra', next: en(3), prompt: 'x' },
    ]);
    expect(r).toEqual({ proximoRecordatorio: null, proximaRutina: null });
    expect(panelScopeVisible(PRIV, DUENO)).toBe(true);
    expect(panelScopeVisible(`telegram:dm:${DUENO}`, DUENO)).toBe(true);
    expect(panelScopeVisible('telegram:dm:420', DUENO)).toBe(false);
    expect(panelScopeVisible(PRIV, undefined)).toBe(false);
    expect(panelScopeVisible('local', undefined)).toBe(true);
  });

  it('ignora fechas pasadas, sin próxima o rutinas que ya no existen', () => {
    const r = calcular([
      { scope: PRIV, name: `${REMINDER_PREFIX}p`, next: en(-5), prompt: 'pasado' },
      { scope: PRIV, name: 'nunca', next: null, prompt: 'x' },
    ]);
    expect(r).toEqual({ proximoRecordatorio: null, proximaRutina: null });
    expect(
      panelNextUp([{ scope: PRIV, name: 'borrada', next: en(5) }], () => undefined, DUENO, now),
    ).toEqual({ proximoRecordatorio: null, proximaRutina: null });
  });

  it('la tarjeta Estado los nombra en español', () => {
    expect(etiquetaCampo('proximoRecordatorio')).toBe('Próximo recordatorio');
    expect(etiquetaCampo('proximaRutina')).toBe('Próxima rutina');
  });
});

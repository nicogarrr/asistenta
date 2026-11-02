import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Las regex de los avisos de memoria se compilan al primer uso, no al importar
 * (cada arranque de `pa` las pagaba aunque no llegara ningún mensaje). El
 * resultado tiene que ser exactamente el mismo que antes: esta tabla se sacó
 * del main anterior al cambio.
 */
const ANTES: [string, string | null][] = [
  ['hola, ¿qué tal?', null],
  ['me llamo Nicolás y vivo en Madrid', 'me llamo Nicolás y vivo en Madrid'],
  ['en realidad, prefiero el té', 'en realidad, prefiero el té'],
  ['no es rojo, sino azul', 'no es rojo, sino azul'],
  ['¿siempre llegas tarde?', null],
  ['¿a qué hora quedamos? prefiero por la tarde', 'prefiero por la tarde'],
  ['resúmeme el último correo que tengo', null],
  ['tengo 40 euros: busca el mejor tren', null],
  ['mi café es sin azúcar, gracias', 'mi café es sin azúcar'],
  ['empezaré a correr el lunes que viene', 'empezaré a correr el lunes que viene'],
  ['he decidido dejar el gimnasio en enero', 'he decidido dejar el gimnasio en enero'],
  ['voy a cambiar de trabajo pronto', 'voy a cambiar de trabajo pronto'],
  ['odio madrugar los domingos', 'odio madrugar los domingos'],
  ['nunca bebo café después de las seis', 'nunca bebo café después de las seis'],
  ['trabajo en una consultora de Bilbao', 'trabajo en una consultora de Bilbao'],
  ['mi objetivo es leer veinte libros', 'mi objetivo es leer veinte libros'],
  ['el correo que tengo es viejo', null],
  ['prefiero 1080p, ¿vale?', 'prefiero 1080p'],
  ['¿me llamo Nico o Nicolás en tu perfil?', 'me llamo Nico o Nicolás en tu perfil'],
  ['Buenos días, muy buenas tardes', null],
  ['dime qué tiempo hace mañana', null],
  ['mejor dicho: quiero el vuelo de las 9', 'mejor dicho: quiero el vuelo de las 9'],
  ['can you check my calendar please', null],
  ['me gustan los gatos naranjas', 'me gustan los gatos naranjas'],
  ['empezare mañana sin falta', 'empezare mañana sin falta'],
  ['la contraseña es hunter2hunter2', null],
  ['ñandú: me gusta el café\nprefiero el té verde', 'prefiero el té verde'],
];

const avisa = (clause: string) =>
  `Parece que revelaste algo duradero: "${clause}". ¿Quieres que lo guarde en tu perfil?`;

const RealRegExp = globalThis.RegExp;
afterEach(() => {
  globalThis.RegExp = RealRegExp;
  vi.resetModules();
});

/** Cuenta solo las regex propias de nudges.ts (las de límite de palabra «\p{L}\p{N}_» y la de peticiones). */
function contarRegexDeNudges(): { count: () => number } {
  let n = 0;
  globalThis.RegExp = new Proxy(RealRegExp, {
    construct(target, args, newTarget) {
      const src = String(args[0] instanceof RealRegExp ? args[0].source : args[0]);
      if (src.includes('\\p{L}\\p{N}_') || src.includes('resúmeme')) n++;
      return Reflect.construct(target, args, newTarget);
    },
  });
  return { count: () => n };
}

describe('nudges: regex perezosas, mismo resultado', () => {
  it('da exactamente lo mismo que antes del cambio', async () => {
    const { detectMemoryWorthy } = await import('../src/memory/nudges.js');
    for (const [text, clause] of ANTES) {
      const got = detectMemoryWorthy(text);
      if (clause === null) expect(got, text).toEqual({ worth: false, suggestion: '' });
      else expect(got, text).toEqual({ worth: true, suggestion: avisa(clause) });
    }
  });

  it('importar el módulo no compila ninguna regex; el primer mensaje las compila una sola vez', async () => {
    vi.resetModules();
    const contador = contarRegexDeNudges();
    const { detectMemoryWorthy } = await import('../src/memory/nudges.js');
    expect(contador.count()).toBe(0);
    const mensajes = () => {
      expect(detectMemoryWorthy('me llamo Nicolás y vivo en Madrid').worth).toBe(true);
      expect(detectMemoryWorthy('¿a qué hora quedamos? prefiero por la tarde').worth).toBe(true);
      expect(detectMemoryWorthy('tengo 40 euros: busca el mejor tren').worth).toBe(false);
    };
    mensajes();
    const tras = contador.count();
    expect(tras).toBeGreaterThan(0);
    mensajes();
    mensajes();
    expect(contador.count()).toBe(tras);
  });
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INTENCION_COOLDOWN_MS,
  INTENCION_MAX_VECES,
  INTENCIONES_MAX,
  IntencionesStore,
  intencionesOrden,
  intencionesVista,
  intencionIntent,
  mencionaClave,
  textoAviso,
  textoCreada,
} from '../src/intenciones.js';

const NOW = Date.UTC(2026, 10, 11, 16, 0);
const H = 3_600_000;
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps15-intenciones-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('gaps-15: recordatorios por tema (OpenClaw «standing intents»)', () => {
  it('entiende la frase; «cuando llegue a casa» no es suya (llegada.ts)', () => {
    expect(intencionIntent('Cuando hable de Indra, recuérdame mirar el dividendo')).toEqual({
      claves: ['Indra'],
      texto: 'mirar el dividendo',
    });
    expect(intencionIntent('si menciono a Ana o a Luis pregúntame por su viaje.')).toEqual({
      claves: ['Ana', 'Luis'],
      texto: 'su viaje',
    });
    expect(
      intencionIntent('cada vez que salga el tema de la hipoteca, dime que llame al banco'),
    ).toEqual({ claves: ['hipoteca'], texto: 'llame al banco' });
    expect(intencionIntent('si hablo con Marta, avísame de devolverle el libro')).toEqual({
      claves: ['Marta'],
      texto: 'devolverle el libro',
    });
    expect(intencionIntent('cuando llegue a casa recuérdame sacar la basura')).toBeNull();
    expect(intencionIntent('recuérdame mañana llamar a Ana')).toBeNull();
    expect(intencionIntent('cuando hable de casa, recuérdame algo')).toBeNull();
  });

  it('la palabra entera, sin tildes ni mayúsculas', () => {
    expect(mencionaClave('¿Qué tal va INDRA hoy?', 'indra')).toBe(true);
    expect(mencionaClave('indrawati', 'indra')).toBe(false);
    expect(mencionaClave('lo de la hipoteca variable', 'Hipotéca')).toBe(true);
    expect(mencionaClave('el banco  Santander', 'banco santander')).toBe(true);
  });

  it('salta una vez al día como mucho, 3 veces en total, y no con el propio mensaje', () => {
    const f = join(dir, 'intenciones.json');
    const s = new IntencionesStore(f);
    const i = s.crear('tg:1', ['Indra'], 'mirar el dividendo', NOW);
    expect(i).not.toBe('lleno');
    // El mismo minuto (el mensaje que la creó, o un eco): no.
    expect(s.disparar('tg:1', 'Indra', NOW + 1000)).toEqual([]);
    expect(s.disparar('tg:1', 'cómo va Indra', NOW + H)).toHaveLength(1);
    expect(s.disparar('tg:1', 'Indra otra vez', NOW + 2 * H)).toEqual([]);
    // Otro chat no la ve.
    expect(s.disparar('tg:2', 'Indra', NOW + 30 * H)).toEqual([]);
    let t = NOW + H;
    for (let n = 1; n < INTENCION_MAX_VECES; n++) {
      t += INTENCION_COOLDOWN_MS;
      const [x] = new IntencionesStore(f).disparar('tg:1', 'indra', t);
      expect(x?.veces).toBe(n + 1);
      if (n + 1 === INTENCION_MAX_VECES) expect(textoAviso(x as never)).toContain('la última vez');
    }
    expect(s.disparar('tg:1', 'indra', t + 2 * INTENCION_COOLDOWN_MS)).toEqual([]);
    expect(s.lista('tg:1', t)).toEqual([]);
  });

  it('caduca a los 90 días; repetida no se duplica; tope por chat; quitar N', () => {
    const s = new IntencionesStore(join(dir, 'intenciones.json'));
    const a = s.crear('tg:1', ['Indra'], 'mirar el dividendo', NOW);
    expect(s.crear('tg:1', ['indra'], 'Mirar el dividendo', NOW + 1)).toEqual(a);
    expect(s.lista('tg:1', NOW + 91 * 86_400_000)).toEqual([]);
    expect(s.disparar('tg:1', 'Indra', NOW + 91 * 86_400_000)).toEqual([]);
    for (let n = 1; n < INTENCIONES_MAX; n++) s.crear('tg:1', [`t${n}`], 'x', NOW);
    expect(s.crear('tg:1', ['sobra'], 'x', NOW)).toBe('lleno');
    expect(textoCreada('lleno')).toContain('tope');
    expect(s.quitar('tg:1', 1, NOW)?.texto).toBe('mirar el dividendo');
    expect(s.quitar('tg:1', 99, NOW)).toBeNull();
    expect(s.lista('tg:1', NOW)).toHaveLength(INTENCIONES_MAX - 1);
  });

  it('textos y /intenciones', () => {
    const s = new IntencionesStore(join(dir, 'intenciones.json'));
    const i = s.crear('tg:1', ['Ana', 'Luis'], 'su viaje', NOW);
    expect(textoCreada(i)).toMatch(
      /^💡 Hecho: cuando hables de «Ana» o «Luis» te recuerdo «su viaje»/,
    );
    expect(intencionesVista(s.lista('tg:1', NOW), NOW)).toContain(
      '1. «Ana» o «Luis» → su viaje · 0/3 veces · caduca en 90 días',
    );
    expect(intencionesVista([], NOW)).toContain('No tienes recordatorios por tema');
    expect(intencionesOrden('')).toEqual({ kind: 'lista' });
    expect(intencionesOrden('quitar 2')).toEqual({ kind: 'quitar', n: 2 });
    expect(intencionesOrden('xyz')).toBeNull();
  });

  it('cli: va antes de llegada.ts, solo en el privado del dueño, y el aviso no corta la respuesta', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const i = src.indexOf('const nueva = it.intencionIntent(inbound.text);');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(
      src.indexOf('const llegada = owner ? llegadaIntent(inbound.text) : null;'),
    );
    const bloque = src.slice(
      src.lastIndexOf('if (inbound.text && isOwnerDm(inbound, vigilanteOwnerId))', i),
      i + 900,
    );
    expect(bloque).toMatch(
      /for \(const i of intenciones\.disparar[^\n]*\n\s*await say\(inbound, it\.textoAviso\(i\), \{ quote: true \}\);\n\s*\}/,
    );
    expect(src).toContain("names: ['intenciones', 'temas']");
  });
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IntencionesStore,
  intencionIntent,
  remitenteCorto,
  textoAviso,
  textoDeCorreo,
} from '../src/intenciones.js';

const NOW = Date.UTC(2026, 10, 11, 18, 0);
const CHAT = 'telegram:default:42';
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps16-correo-intenciones-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const correo = {
  from: '"Marta López" <marta@example.test>',
  subject: 'Quedamos el jueves',
  text: '¿Te viene bien a las 7?\n\n> El mar, 10 nov, Nico escribió:\n> Hablamos de Indra',
};

describe('gaps-16: un correo nuevo también «habla de» un tema', () => {
  it('«cuando hable con Marta» salta con un correo DE Marta', () => {
    const s = new IntencionesStore(join(dir, 'intenciones.json'));
    const pedido = intencionIntent('avísame de devolverle el libro, cuando hable con Marta');
    if (!pedido) throw new Error('sin pedido');
    s.crear(CHAT, pedido.claves, pedido.texto, NOW - 3_600_000);
    const [aviso] = s.disparar(CHAT, textoDeCorreo(correo), NOW);
    if (!aviso) throw new Error('sin aviso');
    expect(
      textoAviso(aviso, {
        correo: { de: remitenteCorto(correo.from), asunto: correo.subject },
      }),
    ).toBe(
      '💡 Te ha llegado un correo de Marta López («Quedamos el jueves») que habla de «Marta». Me pediste que te recordara: devolverle el libro.',
    );
  });

  it('lo citado («> …», lo que escribió Nico) no cuenta', () => {
    expect(textoDeCorreo(correo)).not.toContain('Indra');
    const s = new IntencionesStore(join(dir, 'intenciones.json'));
    s.crear(CHAT, ['Indra'], 'mirar el dividendo', NOW - 3_600_000);
    expect(s.disparar(CHAT, textoDeCorreo(correo), NOW)).toEqual([]);
    expect(
      s.disparar(CHAT, textoDeCorreo({ ...correo, subject: 'Indra: junta de accionistas' }), NOW),
    ).toHaveLength(1);
  });

  it('remitenteCorto', () => {
    expect(remitenteCorto('"Marta López" <marta@example.test>')).toBe('Marta López');
    expect(remitenteCorto('<avisos@banco.example>')).toBe('avisos@banco.example');
    expect(remitenteCorto('ana@x.example')).toBe('ana@x.example');
  });

  it('cli: el aviso de correo nuevo lo mira, solo lo no leído, con «🔕»', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const d = src.indexOf('deliver: async (messages, scope) => {');
    expect(src.slice(d, d + 900)).toContain('await intencionesCorreo(messages)');
    const f = src.indexOf('const intencionesCorreo = async');
    const body = src.slice(f, f + 1500);
    expect(body).toContain('messages.filter((m) => !m.seen)');
    expect(body).toContain('it.OLVIDAR_LABEL');
  });
});

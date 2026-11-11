import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IntencionesStore, textoDeCorreo } from '../src/intenciones.js';
import { toMessage } from '../src/mail/client.js';
import { esMasivo } from '../src/mail/masivo.js';

const mail = (cabeceras: string[], cuerpo = 'Indra sube un 3 % hoy.') =>
  [
    'From: Boletín Bolsa <news@bolsa.example>',
    'To: nico@gmail.com',
    'Subject: Cierre de mercado',
    ...cabeceras,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    cuerpo,
    // Una línea del cuerpo que parece cabecera no cuenta.
    'List-Unsubscribe: esto es texto del cuerpo',
  ].join('\r\n');

describe('gaps-17: los recordatorios por tema no se gastan con boletines', () => {
  it('esMasivo: listas, boletines y avisos automáticos, solo por las cabeceras', () => {
    expect(esMasivo(mail(['List-Unsubscribe: <mailto:baja@bolsa.example>']))).toBe(true);
    expect(esMasivo(mail(['List-Id: Bolsa <bolsa.list.example>']))).toBe(true);
    expect(esMasivo(mail(['Precedence: bulk']))).toBe(true);
    expect(esMasivo(mail(['Auto-Submitted: auto-generated']))).toBe(true);
    // Cabecera doblada (RFC 5322) también.
    expect(esMasivo(mail(['List-Unsubscribe:', ' <https://bolsa.example/baja>']))).toBe(true);
    // Un correo normal de una persona, no; «List-Unsubscribe» en el cuerpo, tampoco.
    expect(esMasivo(mail([]))).toBe(false);
    expect(esMasivo(mail(['Auto-Submitted: no']))).toBe(false);
    expect(esMasivo(undefined)).toBe(false);
    expect(esMasivo(Buffer.from(mail(['Precedence: list'])))).toBe(true);
  });

  it('toMessage marca masivo (y nada más cambia en un correo normal)', () => {
    const base = {
      uid: 7,
      envelope: { from: [{ address: 'news@bolsa.example' }], subject: 'Cierre', date: new Date(0) },
      flags: new Set<string>(),
    };
    const b = toMessage({ ...base, source: mail(['List-Unsubscribe: <mailto:x@y>']) }, 'INBOX');
    expect(b.masivo).toBe(true);
    const n = toMessage({ ...base, source: mail([]) }, 'INBOX');
    expect('masivo' in n).toBe(false);
  });

  it('un boletín de Indra no dispara «cuando hable de Indra» (el daemon lo filtra antes)', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const i = cli.indexOf('const intencionesCorreo = async');
    expect(cli.slice(i, i + 600)).toContain('messages.filter((m) => !m.seen && !m.masivo)');
    // Sin el filtro, el mismo texto sí dispararía: el filtro es lo que lo para.
    const dir = mkdtempSync(join(tmpdir(), 'pa-gaps17-masivo-'));
    try {
      const store = new IntencionesStore(join(dir, 'i.json'));
      store.crear('telegram:dm:1', ['Indra'], 'mirar el dividendo', 0);
      const m = toMessage(
        {
          uid: 1,
          envelope: { from: [{ address: 'news@bolsa.example' }], subject: 'Cierre' },
          source: mail(['List-Unsubscribe: <mailto:x@y>']),
        },
        'INBOX',
      );
      expect(store.disparar('telegram:dm:1', textoDeCorreo(m), 86_400_000)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

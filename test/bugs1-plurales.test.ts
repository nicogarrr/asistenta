import { describe, expect, it } from 'vitest';
import { describeSelection } from '../src/mail/cleanup.js';
import { describeTarget } from '../src/mail/unsubscribe.js';
import { buildChangeNote } from '../src/skills/store.js';
import { formatStatus } from '../src/status.js';

// asis-bugs-1: «1 errores, 1 avisos», «1 correos», «y 1 cambios mas».
describe('singular cuando es uno', () => {
  it('estado: 1 error, 1 aviso', () => {
    const text = formatStatus({
      version: '1.0.0',
      node: '24',
      uptimeMs: 60_000,
      tools: [],
      log: { errors: 1, warns: 1, recentErrors: [] },
    } as unknown as Parameters<typeof formatStatus>[0]);
    expect(text).toContain('Log de hoy: 1 error, 1 aviso.');
    expect(text).not.toContain('1 errores');
  });

  it('correo: 1 correo en la limpieza y en las bajas', () => {
    const one = [
      { uid: 1, from: 'a@tienda.es', subject: 'Oferta', date: '', category: 'publicidad' },
    ] as unknown as Parameters<typeof describeSelection>[0];
    expect(describeSelection(one, 'archivar')).toMatch(/: 1 correo\./);
    expect(
      describeTarget(
        { remitente: 'Tienda', correos: 1, metodo: 'enlace', destino: 'https://t.es/baja' },
        1,
      ),
    ).toContain('(1 correo)');
  });

  it('habilidades: «y 1 cambio más», con tilde', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const notes = Array.from({ length: 30 }, (_, n) =>
      buildChangeNote('motivo', '2026-11-01', 2, old, old.slice(0, 10 - (n % 10))),
    );
    const withOne = notes.find((t) => /y 1 /.test(t));
    if (withOne) expect(withOne).toContain('y 1 cambio más');
    for (const t of notes) expect(t).not.toMatch(/cambios mas\b/);
  });
});

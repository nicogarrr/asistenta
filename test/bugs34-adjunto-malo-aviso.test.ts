import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cargarAdjuntos, configurarAdjuntos, lineasAdjuntos } from '../src/mail/adjuntos.js';

// bugs-34: con un adjunto que no vale, el borrador ponía «✗ x.pdf: no existe (no saldría)»
// junto a los buenos, como si el correo fuera a salir sin él. Pero cargarAdjuntos falla
// entero: Nico aprobaba y recibía «No enviado». El borrador tiene que decirlo claro.

afterEach(() => configurarAdjuntos(null));

describe('borrador con un adjunto que no vale', () => {
  it('avisa de que así no se envía nada (y de verdad no se envía)', () => {
    const base = mkdtempSync(join(tmpdir(), 'bugs34-adjmal-'));
    const docs = join(base, 'Documentos');
    mkdirSync(join(base, 'estado', 'creados'), { recursive: true });
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'tesis.pdf'), Buffer.alloc(2000, 1));
    configurarAdjuntos({
      creadosDir: join(base, 'estado', 'creados'),
      stateDir: join(base, 'estado'),
      roots: [docs],
    });
    const refs = [join(docs, 'tesis.pdf'), join(docs, 'no-existe.pdf')];
    const text = lineasAdjuntos(refs);
    expect(text).toContain('📎 tesis.pdf');
    expect(text).toContain('✗');
    expect(text).not.toContain('no saldría');
    expect(text).toMatch(/el correo no se envía aunque digas que sí/);
    expect(cargarAdjuntos(refs).ok).toBe(false);
    // Todo bien: sin aviso.
    expect(lineasAdjuntos([join(docs, 'tesis.pdf')])).not.toContain('⚠️');
  });
});

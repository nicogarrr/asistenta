/**
 * Primer uso: con un ID de Telegram mal guardado al instalar, el dueño escribe al
 * bot, recibe «Este asistente es privado.» y en el PC solo había una línea técnica
 * en el log. Ahora la consola dice qué ID ha escrito y qué hacer, una vez.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeStrangerHint } from '../src/owner-id-hint.js';

describe('consola: alguien no autorizado escribe al bot', () => {
  it('una línea en castellano con su ID y qué hacer, una vez por persona', () => {
    const hint = makeStrangerHint();
    const text = hint('unauthorised sender', { userId: 987654321, username: 'nico_g' });
    expect(text).toContain('ID de Telegram 987654321, @nico_g');
    expect(text).toContain('le he contestado que es privado');
    expect(text).toContain('doble clic en instalar.bat');
    expect(text).toContain('pa vault set-stdin telegram:allowedUserIds');
    expect(text).not.toMatch(/unauthorised|sender/);
    expect(hint('unauthorised sender', { userId: 987654321, username: 'nico_g' })).toBeNull();
    expect(hint('unauthorised sender', { userId: 5 })).toContain('ID de Telegram 5)');
  });

  it('solo para ese aviso, con un ID de verdad; el nombre no cuela caracteres raros', () => {
    const hint = makeStrangerHint();
    expect(hint('daemon ready', { userId: 1 })).toBeNull();
    expect(hint('unauthorised sender', { userId: 'x' })).toBeNull();
    expect(hint('unauthorised sender', { userId: -3 })).toBeNull();
    expect(hint('unauthorised sender', { label: 'botón' })).toBeNull();
    const t = hint('unauthorised sender', { userId: 7, username: 'a\u001b[31m\nb' }) ?? '';
    expect(t).toContain('@a31mb');
    expect([...t].some((ch) => ch.charCodeAt(0) < 32)).toBe(false);
  });

  it('no crece sin fin: como mucho N personas por ejecución', () => {
    const hint = makeStrangerHint(3);
    const out = [1, 2, 3, 4, 5].map((id) => hint('unauthorised sender', { userId: id }));
    expect(out.filter(Boolean)).toHaveLength(3);
  });

  it('el daemon lo escribe en la consola desde el log de Telegram', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain('const strangerHint = makeStrangerHint();');
    expect(src).toContain('const hint = strangerHint(msg, fields);');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Los botones de permiso hablan como en un chat: «por ahora» en vez de «esta sesión»
// (palabra técnica). Solo cambia el texto; la acción `approve:session:` es la misma.
const telegram = readFileSync('src/channels/telegram.ts', 'utf8');
const panel = readFileSync('src/webui/page.ts', 'utf8');
const permisos = readFileSync('src/permissions.ts', 'utf8');

describe('botones de permiso sin «sesión»', () => {
  it('Telegram: el botón y el aviso dicen «por ahora»', () => {
    expect(telegram).toContain("{ label: '🕒 Por ahora', action: `approve:session:");
    expect(telegram).toContain("session: '✅ Aprobado por ahora'");
    expect(telegram).not.toMatch(/Esta sesión|para esta sesión/);
  });

  it('panel: la opción y su resultado dicen «por ahora»', () => {
    expect(panel).toContain("texto: 'Permitir por ahora'");
    expect(panel).toContain("hecho: 'Permitido por ahora'");
    expect(panel).not.toMatch(/(Permitir|Permitido) en esta sesión/);
  });

  it('/permisos nombra los permisos con las mismas palabras que el botón', () => {
    expect(permisos).toContain('Los de "por ahora" o "una vez" no salen aquí');
    expect(permisos).not.toContain('Los de "esta sesión"');
  });
});

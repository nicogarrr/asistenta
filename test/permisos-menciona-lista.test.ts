import { describe, expect, it } from 'vitest';
import { runPermisosCommand } from '../src/permissions.js';

// /permisos sin argumentos debe llevar al dueño a /permisos lista (fechas y chat).
describe('/permisos menciona /permisos lista', () => {
  it('el uso con un subcomando desconocido lista «lista»', () => {
    expect(runPermisosCommand([], undefined, 'xyz')).toContain('lista');
  });
  it('con permisos «siempre» activos, la respuesta menciona /permisos lista', () => {
    const gate = {
      listPersistedAlways: () => ['shell'],
      listPersistedAlwaysWithChat: () => [{ tool: 'shell', chat: 'telegram:1' }],
    } as unknown as Parameters<typeof runPermisosCommand>[0][number];
    const out = runPermisosCommand([gate], undefined, '', 'telegram:1');
    expect(out).toContain('shell (este chat)');
    expect(out).toContain('/permisos lista');
  });
});

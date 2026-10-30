import { describe, expect, it } from 'vitest';
import { helpText } from '../src/channels/telegram-help.js';
import { funcionCommands } from '../src/funciones.js';

describe('/actualizacion', () => {
  it('sale en /help y en /funciones (Ajustes y sistema)', () => {
    expect(helpText()).toContain('/actualizacion — si me actualizo sola desde main');
    const c = funcionCommands().find((x) => x.command === 'actualizacion');
    expect(c).toBeDefined();
    expect(JSON.stringify(c)).toContain('sistema');
  });
});

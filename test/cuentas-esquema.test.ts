import { validateToolArguments } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { createAccountsTool } from '../src/tools/accounts.js';

// El bucle del agente valida cada llamada contra el esquema ANTES de ejecutarla:
// una acción que no está en el esquema no llega nunca a la herramienta.
const tool = createAccountsTool(
  {
    get: async () => undefined,
    set: async () => {},
    delete: async () => false,
    list: async () => [],
  },
  async () => null,
);
const valid = (args: Record<string, unknown>) =>
  validateToolArguments(
    tool as never,
    { type: 'toolCall', id: 't', name: 'cuentas', arguments: args } as never,
  );

describe('cuentas: los pasos del alta pasan la validación del esquema', () => {
  it.each([
    { action: 'preparar_registro', sitio: 'wallapop.es', sin_simbolos: true, max_largo: 16 },
    { action: 'confirmar_registro', sitio: 'wallapop.es', correo: 'nico@example.com' },
    { action: 'guardar', sitio: 'wallapop.es' },
    { action: 'descartar', sitio: 'wallapop.es' },
    { action: 'listar' },
  ])('$action', (args) => {
    expect(() => valid(args)).not.toThrow();
  });

  it('una acción inventada sigue rechazada', () => {
    expect(() => valid({ action: 'borrar_todo' })).toThrow();
  });
});

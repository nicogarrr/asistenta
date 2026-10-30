import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  type Account,
  findAccounts,
  listAccounts,
  maskUser,
  realVault,
  type VaultOps,
} from '../credentials/store.js';

const Params = Type.Object({
  action: Type.Union([Type.Literal('listar'), Type.Literal('buscar')], {
    description: 'listar = all saved accounts; buscar = is there an account for a site.',
  }),
  sitio: Type.Optional(
    Type.String({ description: 'Site or domain for buscar, e.g. wallapop.es.' }),
  ),
});

const fecha = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : ` desde ${new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Europe/Madrid' }).format(d)}`;
};

const line = (a: Account): string =>
  `${a.domain} (${maskUser(a.username)}${fecha(a.created)}${a.status === 'pendiente' ? ', sin terminar' : ''})`;

/**
 * «¿Qué cuentas tengo?» / «¿Tengo cuenta en Wallapop?»: lee el gestor de contraseñas.
 * Solo lectura y NUNCA devuelve la contraseña (ni siquiera la lee): para entrar en una
 * web el navegador la escribe desde el vault con `secret_key`.
 */
export function createAccountsTool(vault: VaultOps = realVault): AgentTool<typeof Params> {
  return {
    name: 'cuentas',
    label: 'Cuentas',
    description:
      "Owner's password manager (encrypted vault). listar: which sites he has an account on; buscar: is there one for a site. Never returns passwords. To log in, use browser fill with secret_key site:<domain>:username / site:<domain>:password.",
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      let text: string;
      if (args.action === 'buscar') {
        const q = (args.sitio ?? '').trim();
        if (!q) text = '¿De qué web? Dime el nombre o el dominio.';
        else {
          const found = await findAccounts(q, vault);
          text =
            found.length === 0
              ? `No tengo ninguna cuenta guardada de ${q}.`
              : `Sí: ${found.map(line).join('; ')}. Puedo entrar con ella cuando haga falta.`;
        }
      } else {
        const all = await listAccounts(vault);
        text =
          all.length === 0
            ? 'Todavía no tengo ninguna cuenta guardada.'
            : `Tienes ${all.length === 1 ? '1 cuenta' : `${all.length} cuentas`}: ${all.map(line).join('; ')}.`;
      }
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}

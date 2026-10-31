import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  approveSignup,
  discardSignup,
  finishSignup,
  MISSING_IDENTITY,
  type OwnerIdentity,
  ownerIdentity,
  prepareSignup,
} from '../credentials/signup.js';
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
const errText = (err: unknown): string =>
  err instanceof Error ? err.message : 'No he podido hacerlo.';

async function signupStep(
  args: {
    action: string;
    sitio?: string;
    correo?: string;
    sin_simbolos?: boolean;
    max_largo?: number;
  },
  vault: VaultOps,
  owner: () => Promise<OwnerIdentity | null>,
): Promise<string> {
  const sitio = (args.sitio ?? '').trim();
  if (!sitio) return '¿En qué web? Dime el nombre o el dominio.';
  try {
    if (args.action === 'preparar_registro') {
      const me = await owner();
      if (!me) return MISSING_IDENTITY;
      const a = await prepareSignup(
        sitio,
        me,
        { symbols: args.sin_simbolos ? false : undefined, maxLength: args.max_largo },
        vault,
      );
      return [
        `Registro en ${a.domain} preparado (contraseña fuerte ya guardada en el vault).`,
        `Rellena el formulario: nombre «${me.name}», correo con browser fill secret_key=site:${a.domain}:username, contraseña (y su repetición) con secret_key=site:${a.domain}:password.`,
        `NO pulses el botón de crear cuenta todavía: antes llama a cuentas confirmar_registro con sitio=${a.domain} y correo=${a.username}. Tras escribir la contraseña, el navegador no hace clic en esa página sin ese sí.`,
        'Nunca aceptes planes de pago ni metas tarjetas. Si sale un captcha o piden un código (SMS o correo), para y pídeselo al dueño.',
      ].join('\n');
    }
    if (args.action === 'confirmar_registro') {
      const a = await approveSignup(sitio, args.correo ?? '', vault);
      return `Aprobado (vale 10 minutos): pulsa ya el botón de crear cuenta en ${a.domain}. Cuando la web confirme el alta, llama a cuentas guardar; si falla, cuentas descartar.`;
    }
    if (args.action === 'guardar') {
      const a = await finishSignup(sitio, vault);
      return `Cuenta de ${a.domain} creada y guardada en tu gestor de contraseñas (${maskUser(a.username)}).`;
    }
    return (await discardSignup(sitio, vault))
      ? `He descartado el registro a medias de ${sitio}; no queda nada guardado.`
      : `No había ningún registro a medias de ${sitio}.`;
  } catch (err) {
    return errText(err);
  }
}

export function createAccountsTool(
  vault: VaultOps = realVault,
  owner: () => Promise<OwnerIdentity | null> = () => ownerIdentity(process.env, vault),
): AgentTool<typeof Params> {
  return {
    name: 'cuentas',
    label: 'Cuentas',
    description:
      "Owner's password manager (encrypted vault) and account sign-up in his name. listar/buscar: which sites he has an account on. Never returns passwords. To log in, use browser fill with secret_key site:<domain>:username / site:<domain>:password. To create an account («créame una cuenta en X»): preparar_registro, fill the form, confirmar_registro BEFORE clicking submit, then guardar or descartar. Hand CAPTCHAs and SMS/email codes to the owner; never paid plans or card data. To delete an account from the manager or change a saved password, tell the owner to run `pa cuentas borrar <web>` or `pa cuentas cambiar <web>` in a terminal on his PC.",
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      let text: string;
      if (args.action !== 'listar' && args.action !== 'buscar') {
        text = await signupStep(args, vault, owner);
      } else if (args.action === 'buscar') {
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

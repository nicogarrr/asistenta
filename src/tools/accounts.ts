import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { oldPendingOffer, pendingAge } from '../credentials/pending-age.js';
import {
  approveSignup,
  discardSignup,
  finishSignup,
  MISSING_IDENTITY,
  type OwnerIdentity,
  ownerIdentity,
  pendingOf,
  prepareSignup,
} from '../credentials/signup.js';
import { findSignupCode, type MailSearch, realSignupMail } from '../credentials/signup-code.js';
import {
  type Account,
  AvisoCuenta,
  findAccounts,
  listAccounts,
  maskUser,
  realVault,
  type VaultOps,
} from '../credentials/store.js';
import { log } from '../log.js';
import { vaultExists as realVaultExists } from '../vault.js';

const Params = Type.Object({
  action: Type.Union(
    [
      Type.Literal('listar'),
      Type.Literal('buscar'),
      Type.Literal('preparar_registro'),
      Type.Literal('confirmar_registro'),
      Type.Literal('guardar'),
      Type.Literal('descartar'),
      Type.Literal('codigo_registro'),
    ],
    {
      description:
        'listar = all saved accounts; buscar = is there an account for a site; preparar_registro / confirmar_registro / guardar / descartar = the sign-up steps; codigo_registro = read the verification code the site mailed for an approved sign-up.',
    },
  ),
  sitio: Type.Optional(Type.String({ description: 'Site or domain, e.g. wallapop.es.' })),
  correo: Type.Optional(
    Type.String({ description: 'For confirmar_registro: the email of the prepared sign-up.' }),
  ),
  sin_simbolos: Type.Optional(
    Type.Boolean({ description: 'For preparar_registro: the site does not accept symbols.' }),
  ),
  max_largo: Type.Optional(
    Type.Number({ description: 'For preparar_registro: maximum password length the site allows.' }),
  ),
});

const fecha = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : ` desde ${new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Europe/Madrid' }).format(d)}`;
};

const sinTerminar = (a: Account): string => {
  const age = pendingAge(a);
  return `sin terminar${age ? `, ${age}` : ''}`;
};

const line = (a: Account): string =>
  a.status === 'pendiente'
    ? `${a.domain} (${maskUser(a.username)}, ${sinTerminar(a)})`
    : `${a.domain} (${maskUser(a.username)}${fecha(a.created)})`;

/**
 * «¿Qué cuentas tengo?» / «¿Tengo cuenta en Wallapop?»: lee el gestor de contraseñas.
 * Solo lectura y NUNCA devuelve la contraseña (ni siquiera la lee): para entrar en una
 * web el navegador la escribe desde el vault con `secret_key`.
 */
/** Los avisos propios del registro llegan tal cual; un fallo del vault, en llano (crudo solo al log). */
const errText = (err: unknown, action: string, hasVault: () => boolean): string => {
  if (err instanceof AvisoCuenta) return err.message;
  if (!vaultThere(hasVault)) return SIGNUP_NO_VAULT;
  log.warn('cuentas: fallo del gestor de contraseñas en el registro', {
    action,
    error: err instanceof Error ? err.message : String(err),
  });
  return SIGNUP_VAULT_FAILED;
};

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
  mail: MailSearch = realSignupMail,
  shown?: string,
  hasVault: () => boolean = () => true,
): Promise<string> {
  const sitio = (args.sitio ?? '').trim();
  if (!sitio) return '¿En qué web? Dime el nombre o el dominio.';
  try {
    if (args.action === 'codigo_registro') return await findSignupCode(sitio, mail, vault);
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
      const a = await approveSignup(sitio, args.correo ?? '', vault, shown);
      return `Aprobado (vale 10 minutos): pulsa ya el botón de crear cuenta en ${a.domain}. Cuando la web confirme el alta, llama a cuentas guardar; si falla, cuentas descartar.`;
    }
    if (args.action === 'guardar') {
      const a = await finishSignup(sitio, vault);
      return `Cuenta de ${a.domain} creada y guardada en tu gestor de contraseñas (${maskUser(a.username)}).`;
    }
    // Con el nombre a secas se nombra la web de verdad («de wallapop.es», no «de wallapop»).
    const p = await pendingOf(sitio, vault, true);
    // El dueño dijo sí a descartar la web exacta que le enseñó la pregunta: si ahora el nombre
    // lleva a otra, ese sí no vale para ella.
    if (p && shown && p.domain !== shown)
      return `No he descartado nada: ahora «${sitio}» no lleva a ${shown}. Dime la web exacta.`;
    return p && (await discardSignup(p.domain, vault))
      ? `He descartado el registro a medias de ${p.domain}; no queda nada guardado.`
      : `No había ningún registro a medias de ${sitio}.`;
  } catch (err) {
    return errText(err, args.action, hasVault);
  }
}

export function createAccountsTool(
  vault: VaultOps = realVault,
  owner: () => Promise<OwnerIdentity | null> = () => ownerIdentity(process.env, vault),
  mail: MailSearch = realSignupMail,
  // Instalación nueva: todavía no hay caja fuerte. Con un vault de prueba, se da por hecho que sí.
  hasVault: () => boolean = vault === realVault ? realVaultExists : () => true,
): AgentTool<typeof Params> & { gateHint: (args: Record<string, unknown>) => Promise<string> } {
  // La web exacta que la pregunta de la Gate enseñó al dueño para cada confirmar_registro
  // (por nombre+correo). Con ella, «confirma wallapop» pide un solo sí en vez de dos.
  const shown = new Map<string, { domain: string; at: number }>();
  const shownKey = (a: Record<string, unknown>): string =>
    `${String(a.action ?? '')}|${String(a.sitio ?? '')
      .trim()
      .toLowerCase()}|${String(a.correo ?? '')
      .trim()
      .toLowerCase()}`;
  const takeShown = (a: Record<string, unknown>): string | undefined => {
    const k = shownKey(a);
    const s = shown.get(k);
    shown.delete(k);
    return s && Date.now() - s.at < SHOWN_TTL_MS ? s.domain : undefined;
  };
  return {
    // Para la pregunta de la Gate: la web exacta del alta a medias que encaja con el nombre
    // (nunca mezcla webs distintas: si encajan varias, no hay pista y el paso pregunta cuál).
    gateHint: async (args) => {
      const a = args.action;
      if (a !== 'confirmar_registro' && a !== 'codigo_registro' && a !== 'descartar') return '';
      const sitio = typeof args.sitio === 'string' ? args.sitio.trim() : '';
      if (!sitio) return '';
      const p = await pendingOf(sitio, vault, true).catch(() => null);
      if (a === 'confirmar_registro' || a === 'descartar') {
        if (p) shown.set(shownKey(args), { domain: p.domain, at: Date.now() });
        else shown.delete(shownKey(args));
      }
      return p?.domain ?? '';
    },
    name: 'cuentas',
    label: 'Cuentas',
    description:
      "Owner's password manager (encrypted vault) and account sign-up in his name. listar/buscar: which sites he has an account on (buscar on one site also gives the full username, for «¿cuál es mi usuario en X?»). Never returns passwords. To log in, use browser fill with secret_key site:<domain>:username / site:<domain>:password. To create an account («créame una cuenta en X»): preparar_registro, fill the form, confirmar_registro BEFORE clicking submit, then guardar or descartar. If the site emails a verification code, cuentas codigo_registro reads just that code (the owner approves each time; it never opens links). sitio can be a bare name («regístrame en wallapop», «confirma lo de wallapop»): confirmar_registro, guardar, descartar and codigo_registro resolve it when only one half-done sign-up matches, and say which ones if several do; preparar_registro needs the exact domain (wallapop.es), so pass it if you know it or ask the owner. descartar asks the owner first, naming the exact site. Hand CAPTCHAs, SMS codes and confirmation links to the owner; never paid plans or card data. To delete an account from the manager or change a saved password, tell the owner to run `pa cuentas borrar <web>` or `pa cuentas cambiar <web>` in a terminal on his PC.",
    parameters: Params,
    executionMode: 'parallel',
    execute: async (_id, args) => {
      let text: string;
      if (args.action !== 'listar' && args.action !== 'buscar') {
        const seen =
          args.action === 'confirmar_registro' || args.action === 'descartar'
            ? takeShown(args as Record<string, unknown>)
            : undefined;
        text = await signupStep(args, vault, owner, mail, seen, hasVault);
      } else {
        text = await readStep(args, vault, hasVault);
      }
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}

/** listar / buscar. Si el gestor no se puede leer, una línea llana (el error, solo al log). */
async function readStep(
  args: { action: string; sitio?: string },
  vault: VaultOps,
  hasVault: () => boolean,
): Promise<string> {
  let text: string;
  try {
    if (args.action === 'buscar') {
      const q = (args.sitio ?? '').trim();
      if (!q) text = '¿De qué web? Dime el nombre o el dominio.';
      else {
        const found = await findAccounts(q, vault);
        // Una sola web: «¿cuál es mi usuario en X?» recibe el usuario entero (nunca la
        // contraseña). Con varias, el usuario va tapado como en listar.
        const one = found.length === 1 ? found[0] : undefined;
        text =
          found.length === 0
            ? `No tengo ninguna cuenta guardada de ${q}.`
            : one
              ? `Sí, en ${one.domain}: tu usuario es ${one.username || '(sin usuario guardado)'}${one.status === 'pendiente' ? `, alta ${sinTerminar(one)}` : fecha(one.created)}. La contraseña no la enseño; entro con ella cuando haga falta.`
              : `Sí: ${found.map(line).join('; ')}. Puedo entrar con ella cuando haga falta.`;
      }
    } else {
      const all = await listAccounts(vault);
      text =
        all.length === 0
          ? 'Todavía no tengo ninguna cuenta guardada.'
          : `Tienes ${all.length === 1 ? '1 cuenta' : `${all.length} cuentas`}: ${all.map(line).join('; ')}.${oldPendingOffer(all) ? ` ${oldPendingOffer(all)}` : ''}`;
    }
  } catch (err) {
    log.warn('cuentas: no se pudo leer el gestor de contraseñas', {
      error: err instanceof Error ? err.message : String(err),
    });
    text = vaultThere(hasVault) ? VAULT_UNREADABLE : NO_VAULT_YET;
  }
  return text;
}

/** Lo que el dueño vio en la pregunta vale para la llamada que sigue, no para siempre. */
const SHOWN_TTL_MS = 10 * 60_000;

/** Si no se puede saber, se supone que la caja fuerte existe (el aviso de siempre). */
const vaultThere = (hasVault: () => boolean): boolean => {
  try {
    return hasVault();
  } catch {
    return true;
  }
};

export const NO_VAULT_YET =
  'Todavía no tengo ninguna cuenta guardada: aún no tienes caja fuerte de claves. Se crea al instalar (doble clic en instalar.bat) o con pa vault init.';

export const SIGNUP_NO_VAULT =
  'Todavía no tienes caja fuerte de claves, así que no puedo guardar la contraseña del alta; no he tocado nada en la web. Se crea al instalar (doble clic en instalar.bat) o con pa vault init; luego vuelve a pedírmelo.';

export const VAULT_UNREADABLE =
  'Ahora mismo no puedo leer tu gestor de contraseñas. Prueba otra vez en un momento; si sigue igual, `pa doctor` te dice qué le pasa.';

export const SIGNUP_VAULT_FAILED =
  'No he podido usar tu gestor de contraseñas para el registro; no he tocado nada en la web. Prueba otra vez en un momento; si sigue igual, `pa doctor` te dice qué le pasa.';

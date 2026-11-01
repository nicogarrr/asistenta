import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';

/**
 * «Enciende la luz del salón»: Home Assistant local, gratis y sin nube.
 *
 * Solo se carga si el dueño puso PA_HA_URL (su Home Assistant en casa); el token
 * va en el vault (homeassistant:token), nunca en el chat ni en el log. Solo habla
 * con una dirección de la red de casa (IP privada, localhost o *.local): un
 * Home Assistant expuesto a internet no se usa desde aquí. Mirar el estado es
 * lectura; encender, apagar o alternar pide permiso cada vez (regla ask-casa-accion
 * en permissions.ts). Solo luces, enchufes e interruptores y ventiladores.
 */
export const CASA_TOOL_NAME = 'casa';

const DOMAINS = new Set(['light', 'switch', 'fan']);
const ENTITY = /^([a-z_]+)\.[a-z0-9_]{1,64}$/;
const TIMEOUT_MS = 10_000;
const MAX_LIST = 30;

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('estado'),
    Type.Literal('encender'),
    Type.Literal('apagar'),
    Type.Literal('alternar'),
  ]),
  entidad: Type.Optional(
    Type.String({
      description:
        'Entity id de Home Assistant, p. ej. light.salon. Sin ella, estado lista luces, enchufes y ventiladores.',
    }),
  ),
});

export interface CasaConfig {
  url: string;
  token: string;
}

export interface CasaDeps {
  /** URL (PA_HA_URL) y token del vault; null si falta algo. */
  config: () => Promise<CasaConfig | null>;
  fetch?: typeof fetch;
}

export const CASA_NOT_SET =
  'Falta configurar Home Assistant: pon PA_HA_URL en .env (p. ej. http://homeassistant.local:8123) y guarda el token con `pa vault set-stdin homeassistant:token`.';

/** Solo la red de casa: IP privada, localhost o un nombre .local. */
export function isHomeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === 'homeassistant' || host.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

interface HaState {
  entity_id?: unknown;
  state?: unknown;
  attributes?: { friendly_name?: unknown };
}

const label = (s: HaState): string => {
  const name = typeof s.attributes?.friendly_name === 'string' ? s.attributes.friendly_name : '';
  const state = s.state === 'on' ? 'encendido' : s.state === 'off' ? 'apagado' : String(s.state);
  return `${name || String(s.entity_id)}: ${state}`;
};

export function createCasaTool(deps: CasaDeps): AgentTool<typeof Params> {
  const doFetch = deps.fetch ?? fetch;
  const call = async (cfg: CasaConfig, path: string, body?: unknown): Promise<unknown> => {
    const res = await doFetch(new URL(path, cfg.url), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error('token');
    if (!res.ok) throw new Error(`http ${res.status}`);
    return res.json();
  };
  const reply = (text: string, details: Record<string, unknown> = {}) => ({
    content: [{ type: 'text' as const, text }],
    details,
  });
  return {
    name: CASA_TOOL_NAME,
    label: 'Casa',
    description: [
      'Home Assistant de casa (luces, enchufes, ventiladores). action=estado mira cómo están;',
      'encender, apagar y alternar necesitan entidad (p. ej. light.salon) y piden permiso al dueño.',
    ].join(' '),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const cfg = await deps.config().catch(() => null);
      if (!cfg?.url || !cfg.token) return reply(CASA_NOT_SET, { configured: false });
      if (!isHomeUrl(cfg.url)) {
        return reply(
          'PA_HA_URL no es una dirección de casa (IP privada o .local); por seguridad no la uso.',
          { configured: false },
        );
      }
      const entity = String(args.entidad ?? '')
        .trim()
        .toLowerCase();
      const match = ENTITY.exec(entity);
      try {
        if (args.action === 'estado') {
          if (entity) {
            if (!match) return reply(`«${entity}» no parece una entidad de Home Assistant.`);
            return reply(label((await call(cfg, `/api/states/${entity}`)) as HaState));
          }
          const all = (await call(cfg, '/api/states')) as HaState[];
          const mine = (Array.isArray(all) ? all : []).filter((s) =>
            DOMAINS.has(String(s.entity_id).split('.')[0] ?? ''),
          );
          if (mine.length === 0) return reply('No veo luces, enchufes ni ventiladores.');
          const shown = mine.slice(0, MAX_LIST).map(label);
          const more = mine.length > MAX_LIST ? ` (y ${mine.length - MAX_LIST} más)` : '';
          return reply(`${shown.join('; ')}${more}`, { count: mine.length });
        }
        if (!match || !DOMAINS.has(match[1] ?? '')) {
          return reply(
            'Solo puedo encender o apagar luces, enchufes y ventiladores (light., switch., fan.).',
          );
        }
        const service = { encender: 'turn_on', apagar: 'turn_off', alternar: 'toggle' }[
          args.action
        ];
        await call(cfg, `/api/services/${match[1]}/${service}`, { entity_id: entity });
        const done = { encender: 'Encendido', apagar: 'Apagado', alternar: 'Cambiado' }[
          args.action
        ];
        return reply(`${done}: ${entity}.`, { entity, service });
      } catch (err) {
        log.warn('casa: home assistant failed', { err: String(err) });
        const why = String(err).includes('token')
          ? 'Home Assistant no acepta el token; vuelve a guardarlo con `pa vault set-stdin homeassistant:token`.'
          : 'No he podido hablar con Home Assistant; mira que esté encendido y en la misma red.';
        return reply(why, { ok: false });
      }
    },
  };
}

/**
 * Tailscale para abrir el panel y la voz desde el móvil sin abrir puertos (docs/SETUP-INTEGRACIONES.md).
 *
 * Asistenta no instala ni configura Tailscale: solo pregunta a la CLI de Tailscale del PC
 * (`tailscale status --json` y `tailscale serve status --json`) para saber si está
 * conectado, cuál es su nombre MagicDNS (`tu-pc.tu-red.ts.net`) y si `tailscale serve`
 * publica el panel dentro de su red. Con eso `/tailscale` dice qué falta y `/panel` y
 * `/voz` sacan el botón de la Mini App de Telegram con la dirección https correcta.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { parseAllowedHosts } from './webui/server.js';

/** Ejecuta la CLI de Tailscale; `null` si no está instalada o no responde. */
export type TailscaleRun = (args: string[]) => Promise<string | null>;

export interface TailscaleInfo {
  /** La CLI respondió. */
  installed: boolean;
  /** Conectado a su red (BackendState «Running»). */
  running: boolean;
  /** «tu-pc.tu-red.ts.net» sin punto final; vacío si no hay MagicDNS. */
  dnsName: string;
  /** IP 100.x del PC dentro de la red. */
  ip: string;
  /** `tailscale serve` publica el puerto del panel (solo dentro de la red). */
  serving: boolean;
  /** `tailscale funnel` está encendido: el panel saldría a Internet. */
  funnel: boolean;
}

const WINDOWS_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';

/** Ruta de la CLI: en Windows el instalador no siempre la deja en el PATH. */
export function tailscaleExe(
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string {
  return platform === 'win32' && exists(WINDOWS_EXE) ? WINDOWS_EXE : 'tailscale';
}

export function defaultTailscaleRun(): TailscaleRun {
  const exe = tailscaleExe();
  return (args) =>
    new Promise((resolve) => {
      try {
        execFile(exe, args, { timeout: 8000, windowsHide: true }, (err, stdout) =>
          resolve(err ? (stdout ? String(stdout) : null) : String(stdout)),
        );
      } catch {
        resolve(null);
      }
    });
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Lee el estado de Tailscale del PC. `port` es el del panel (8787 por defecto). */
export async function readTailscale(run: TailscaleRun, port: number): Promise<TailscaleInfo> {
  const status = parseJson(await run(['status', '--json']));
  const empty: TailscaleInfo = {
    installed: false,
    running: false,
    dnsName: '',
    ip: '',
    serving: false,
    funnel: false,
  };
  if (!status) return empty;
  const self = (status.Self ?? {}) as Record<string, unknown>;
  const dns = typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '').toLowerCase() : '';
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  const ip = String(ips.find((x) => typeof x === 'string' && x.startsWith('100.')) ?? '');
  const info: TailscaleInfo = {
    ...empty,
    installed: true,
    running: status.BackendState === 'Running',
    dnsName: dns.endsWith('.ts.net') ? dns : '',
    ip,
  };
  if (!info.running) return info;
  const serve = await run(['serve', 'status', '--json']);
  const text = serve ?? '';
  const target = new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`);
  info.serving = target.test(text);
  const sj = parseJson(serve);
  const funnelMap = (sj?.AllowFunnel ?? {}) as Record<string, unknown>;
  info.funnel = Object.values(funnelMap).some((v) => v === true);
  return info;
}

/** Dirección https del panel dentro de la red Tailscale, o '' si aún no se puede usar. */
export function tailnetPanelUrl(info: TailscaleInfo, env: NodeJS.ProcessEnv): string {
  if (!info.running || !info.serving || !info.dnsName || info.funnel) return '';
  if (!parseAllowedHosts(env.PA_WEB_ALLOWED_HOSTS).includes(info.dnsName)) return '';
  return `https://${info.dnsName}/`;
}

/** Texto de `/tailscale`: qué está bien y el siguiente paso que falta, en castellano. */
export function tailscaleReport(info: TailscaleInfo, env: NodeJS.ProcessEnv, port: number): string {
  const guia = 'Pasos: docs/SETUP-INTEGRACIONES.md, apartado Tailscale.';
  if (!info.installed) {
    return `🔌 Tailscale no está instalado en el PC (o no responde).\nInstálalo desde tailscale.com/download en el PC y en el móvil, con la misma cuenta. ${guia}`;
  }
  if (!info.running) {
    return `🔌 Tailscale está instalado pero desconectado. Ábrelo en el PC e inicia sesión. ${guia}`;
  }
  const lines = [`✅ Tailscale conectado${info.ip ? ` (${info.ip})` : ''}.`];
  if (!info.dnsName) {
    lines.push(
      '⚠️ Falta MagicDNS: actívalo en login.tailscale.com → DNS → «Enable MagicDNS» y «HTTPS Certificates».',
    );
    lines.push(guia);
    return lines.join('\n');
  }
  lines.push(`🌐 Nombre del PC: ${info.dnsName}`);
  if (info.funnel) {
    lines.push(
      '⛔ Tienes «tailscale funnel» encendido: eso publica el panel en Internet. Apágalo con «tailscale funnel reset» en el PC.',
    );
    return lines.join('\n');
  }
  if (!info.serving) {
    lines.push(`⚠️ Falta publicar el panel en tu red. En el PC: tailscale serve --bg ${port}`);
    lines.push(guia);
    return lines.join('\n');
  }
  if (!parseAllowedHosts(env.PA_WEB_ALLOWED_HOSTS).includes(info.dnsName)) {
    lines.push(
      `⚠️ Falta en .env: PA_WEB_ALLOWED_HOSTS=${info.dnsName} (y reinicia Asistenta). Sin eso el panel rechaza la visita.`,
    );
    return lines.join('\n');
  }
  lines.push(
    `✅ Panel en tu red: https://${info.dnsName}/ (solo tus dispositivos con Tailscale).`,
    '📱 Escribe /panel para abrirlo dentro de Telegram, o /voz para hablar conmigo desde el móvil.',
  );
  return lines.join('\n');
}

/** Puerto del panel según .env (8787 por defecto, como panel-doctor). */
export function panelPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.PA_WEB_PORT ?? '').trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8787;
}

export interface TailscaleReply {
  text: string;
  buttons?: Array<{ label: string; action: string }>;
}

/**
 * `/tailscale` (estado y qué falta) y `/panel` (botón de la Mini App con el panel).
 * Sin Tailscale listo, `/panel` explica el paso que falta en vez de un botón roto.
 */
export async function tailscaleCommand(
  kind: 'estado' | 'panel' | 'voz',
  deps: { env: NodeJS.ProcessEnv; run: TailscaleRun },
): Promise<TailscaleReply> {
  const port = panelPort(deps.env);
  if ((deps.env.PA_WEB_PORT ?? '').trim() === '0') {
    return {
      text: 'El panel está apagado (PA_WEB_PORT=0 en .env). Quita esa línea y reinicia Asistenta.',
    };
  }
  const info = await readTailscale(deps.run, port);
  const report = tailscaleReport(info, deps.env, port);
  if (kind === 'estado') return { text: report };
  const url = tailnetPanelUrl(info, deps.env);
  if (!url) {
    return {
      text: `Aún no puedo abrirte el panel en Telegram. ${report}`,
    };
  }
  if (kind === 'voz') {
    return {
      text: '🎙️ Habla conmigo desde el móvil: pulsas, hablas y te contesto en voz alta. Con «Manos libres» la conversación sigue sola. Necesita Tailscale encendido en el móvil.',
      buttons: [{ label: '🎙️ Hablar', action: `webapp:${url}voz` }],
    };
  }
  return {
    text: '📱 Tu panel, dentro de Telegram. Funciona con Tailscale encendido en el móvil. Si se queda en gris, abre la app de Tailscale en el móvil, comprueba que dice «Conectado» y vuelve a pulsar.',
    buttons: [{ label: '📱 Abrir panel', action: `webapp:${url}` }],
  };
}

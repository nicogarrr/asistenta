/**
 * Pasada del vigilante de precios (node dist/watch/pricewatch-cli.js). Pensado para cron
 * (p. ej. cada 6 h); una pasada tarda ~ N x 30 s por dominio a propósito.
 *
 * Config (JSON, ruta en PRICEWATCH_CONFIG o `<estado>/pricewatch.json`), releída en cada pasada:
 * { "enabled": false, "gapSeconds": 30, "minDropPct": 70,
 *   "products": [ { "name": "AirPods Pro 3", "urls": { "amazon": "B0FQF32239",
 *       "mediamarkt": "https://www.mediamarkt.es/es/product/..." } } ],
 *   "telegram": { "enabled": false, "chatId": "<id>", "tokenFile": "/ruta/privada" } }
 * El token NUNCA va en la config ni en logs: solo en `tokenFile` (privado: el módulo no verifica
 * sus permisos) o en la variable PRICEWATCH_TG_TOKEN. Con enabled=false no se hace ninguna
 * petición. Sin telegram.enabled=true las alertas solo se escriben en stdout.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STATE_DIR } from '../paths.js';
import { hostOf, PriceStore, parseConfig, robotsDisallows, runOnce } from './pricewatch.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = {
  'user-agent': UA,
  'accept-language': 'es-ES,es;q=0.9',
  accept: 'text/html,application/xhtml+xml',
};

const configPath = process.env.PRICEWATCH_CONFIG ?? join(STATE_DIR, 'pricewatch.json');
const cfg = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
if (!cfg.enabled) {
  process.stdout.write('pricewatch desactivado (enabled=false): sin peticiones\n');
  process.exit(0);
}

function telegramNotify(): (text: string) => Promise<void> {
  const t = cfg.telegram;
  if (!t.enabled || !t.chatId)
    return async (text) => void process.stdout.write(`[alerta sin enviar]\n${text}\n`);
  const token = (
    process.env.PRICEWATCH_TG_TOKEN ?? (t.tokenFile ? readFileSync(t.tokenFile, 'utf8') : '')
  ).trim();
  if (!token) throw new Error('telegram.enabled pero sin token (tokenFile o PRICEWATCH_TG_TOKEN)');
  return async (text) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage ${res.status}`);
  };
}

const robotsCache = new Map<string, string>();
async function robotsAllows(url: string): Promise<boolean> {
  const host = hostOf(url);
  if (!robotsCache.has(host)) {
    try {
      const res = await fetch(`https://${host}/robots.txt`, { headers: HEADERS });
      robotsCache.set(host, res.ok ? await res.text() : '');
    } catch {
      robotsCache.set(host, '');
    }
  }
  const u = new URL(url);
  return !robotsDisallows(robotsCache.get(host) ?? '', u.pathname + u.search);
}

const db = new DatabaseSync(join(STATE_DIR, 'pricewatch.sqlite'));
const summary = await runOnce({
  store: new PriceStore(db),
  products: cfg.products,
  gapMs: cfg.gapMs,
  minDropPct: cfg.minDropPct,
  now: Date.now,
  random: Math.random,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  notify: telegramNotify(),
  robotsAllows,
  fetchPage: async (url) => {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    return { status: res.status, html: await res.text() };
  },
});
process.stdout.write(`pricewatch: ${JSON.stringify(summary)}\n`);

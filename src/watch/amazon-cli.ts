/**
 * Pasada del vigilante de Amazon.es (node dist/watch/amazon-cli.js). Pensado para cron (p. ej. cada 6 h); una pasada
 * de N ASIN tarda ~N x 30 s a propósito.
 *
 * Config (JSON, ruta en AMAZON_WATCH_CONFIG o `<estado>/amazon-watch.json`), releída en
 * cada pasada: { "enabled": false, "asins": ["B0..."], "gapSeconds": 30,
 *   "telegram": { "enabled": false, "chatId": "<id>", "tokenFile": "/ruta/solo-lectura" } }
 * El token NUNCA va en la config ni en logs: solo en `tokenFile` (solo lectura del dueño; el módulo no lo comprueba) o en la
 * variable AMAZON_WATCH_TG_TOKEN. Con enabled=false no se hace ninguna petición.
 * Sin telegram.enabled=true las alertas solo se escriben en el log local.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STATE_DIR } from '../paths.js';
import { AmazonStore, parseConfig, runOnce } from './amazon.js';

const configPath = process.env.AMAZON_WATCH_CONFIG ?? join(STATE_DIR, 'amazon-watch.json');
const cfg = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
if (!cfg.enabled) {
  process.stdout.write('amazon-watch desactivado (enabled=false): sin peticiones\n');
  process.exit(0);
}

function telegramNotify(): (text: string) => Promise<void> {
  const t = cfg.telegram;
  if (!t?.enabled || !t.chatId)
    return async (text) => void process.stdout.write(`[alerta sin enviar]\n${text}\n`);
  const token = (
    process.env.AMAZON_WATCH_TG_TOKEN ?? (t.tokenFile ? readFileSync(t.tokenFile, 'utf8') : '')
  ).trim();
  if (!token)
    throw new Error('telegram.enabled pero sin token (tokenFile o AMAZON_WATCH_TG_TOKEN)');
  return async (text) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`telegram sendMessage ${res.status}`);
  };
}

const db = new DatabaseSync(join(STATE_DIR, 'amazon-watch.sqlite'));
const summary = await runOnce({
  store: new AmazonStore(db),
  asins: cfg.asins,
  gapMs: cfg.gapMs,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  notify: telegramNotify(),
  fetchPage: async (url) => {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'accept-language': 'es-ES,es;q=0.9',
      },
      redirect: 'follow',
    });
    return { status: res.status, html: await res.text() };
  },
});
process.stdout.write(`amazon-watch: ${JSON.stringify(summary)}\n`);

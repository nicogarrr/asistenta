// Preload del daemon de QA (scripts/qa-daemon/run.sh): grammy queda sin red, así el
// daemon real arranca sin hablar nunca con api.telegram.org ni con un token real.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const req = createRequire(`${process.cwd()}/package.json`);
const g = await import(pathToFileURL(req.resolve('grammy')).href);
const { Bot, Api } = g;
Bot.prototype.start = async function (opts) { this.__fake = true; await opts?.onStart?.({ id: 1, is_bot: true, first_name: 'qa', username: 'qa_bot' }); return new Promise(() => {}); };
Bot.prototype.init = async function () { this.botInfo = { id: 1, is_bot: true, first_name: 'qa', username: 'qa_bot' }; };
Bot.prototype.stop = async function () {};
for (const m of Object.getOwnPropertyNames(Api.prototype)) {
  if (m === 'constructor') continue;
  const d = Object.getOwnPropertyDescriptor(Api.prototype, m);
  if (typeof d?.value !== 'function') continue;
  Api.prototype[m] = async function (...a) { process.stderr.write(`[fake-tg] ${m}\n`); return m === 'getUpdates' ? [] : true; };
}
process.stderr.write('[preload] grammy offline\n');

import { start, state } from './shop.mjs';
const R = process.env.PA_DIST || '/home/sandbox/asistenta/dist';
const mode = process.argv[2] || 'deny'; // deny: human denies every ask; human: approves asks except ones about paying
const prompt = process.argv[3];
const REAL = process.env.REAL_HOSTS; if (!REAL) await start(8765);
import fs from 'node:fs'; fs.mkdirSync((process.env.QA_SHOTS || '/tmp/qa-shots'),{recursive:true}); let shotN=0;
const { loadConfig } = await import(R + '/config.js');
const { createDaemonGate } = await import(R + '/cli.js');
const { PersonalAgent } = await import(R + '/core/agent.js');
const { BrowserService } = await import(R + '/browser/service.js');
const { createBrowserTool } = await import(R + '/tools/browser.js');
const { createCheckoutTool, createCheckoutPage } = await import(R + '/tools/checkout.js');
const { createDoneTool } = await import(R + '/tools/done.js');
const config = loadConfig();
const asks = [];
let lastCall = null; const ADDR = process.env.QA_ADDRESS || '';
const gate = createDaemonGate({ threadKey: 'qa#1', dbPath: (process.env.PA_STATE_DIR || '/tmp') + '/qa-approvals.db', ask: async (k, tool, reason, q) => {
  const text = (q ?? reason);
  let approve = mode === 'human' && !/pagar|pay/i.test(text);
  if (mode === 'synth') { const a = lastCall?.args ?? {}; approve = lastCall?.tool === 'browser' && a.action !== 'exec_js' && !/destino ilegible|no est[aá] en la lista/i.test(text) && !/pagar|pay|pago|tarjeta|contrase/i.test(text); }
  if (mode === 'narrow') { const a = lastCall?.args ?? {}; approve = lastCall?.tool === 'browser' && ['fill','choose'].includes(a.action) && ADDR !== '' && String(a.text ?? '') === ADDR && (a.action === 'fill' || !a.option || (/Plaza Mayor/i.test(a.option) && /Gij/i.test(a.option))) && /cityFinder/.test(String(a._target ?? '')); }
  if (mode === 'narrow' && !approve && lastCall?.tool === 'browser' && lastCall?.args?.action === 'click') { const t = String(lastCall.args._target ?? ''); approve = /COMPLETAR DIRECCI/i.test(t) && /Plaza Mayor, 1, GIJON/i.test(t) && /dominospizza\.es/.test(t) && !/tel[eé]fono|pagar|confirmar pedido/i.test(t); }
  if (mode === 'narrow' && !approve && lastCall?.tool === 'browser') { const a = lastCall.args ?? {}; const t = String(a._target ?? ''); if (a.action === 'wait') approve = true; else if (a.action === 'click' && t && !/destino ilegible/i.test(t) && /dominospizza\.es/.test(t) && !/pagar|pago|tarjeta|iniciar sesi|registr|tel[eé]fono|e-?mail|correo|confirmar pedido|finalizar|checkout|realizar pedido|tramitar|continuar al pago|contrase/i.test(t)) approve = true; }
  if (REAL) console.log('ASKARGS ' + JSON.stringify({ tool: lastCall?.tool, action: lastCall?.args?.action, text: lastCall?.args?.text, sel: lastCall?.args?.selector, tgt: String(lastCall?.args?._target ?? '').slice(0,160), approve }).slice(0,300));
  if (REAL) console.log('ASK ' + text.replace(/\n/g,' | ').slice(0,300));
  asks.push({ tool, approve, q: text.slice(0, 300) });
  return { approved: approve, scope: 'once' };
}});
const oc = gate.check.bind(gate); gate.check = async (s2, c) => { lastCall = c; return oc(s2, c); };
const svc = new BrowserService({ policy: { allowPrivateHosts: !REAL, autoApprove: false, approve: async (s, d) => REAL ? REAL.split(',').some(h => d === h || d.endsWith('.'+h)) : (d === '127.0.0.1' || d === 'localhost') }, channel: 'chrome', timeoutMs: 30000 });
const scope = () => 'qa#1';
const bt = createBrowserTool(svc, scope); const gh = bt.gateHint; bt.gateHint = async (a) => { try { return await gh(a); } catch (e) { console.log('HINTERR ' + JSON.stringify(a) + ' -> ' + String(e).slice(0,200)); throw e; } }; const ex = bt.execute; bt.execute = async (id, a, ...r) => { console.log('CALL ' + JSON.stringify(a).slice(0,200)); await new Promise(r=>setTimeout(r,3500)); const out = await ex(id, a, ...r); try { const full = (out.content||[]).map(c=>c.text||'').join(' '); fs.appendFileSync((process.env.QA_RESULTS || '/tmp/qa-results.jsonl'), JSON.stringify({ t: Date.now(), action: a.action, full }) + '\n'); console.log('RESULT[EXCERPT first 300 chars; full text in QA_RESULTS file] ' + JSON.stringify(full.slice(0,300))); } catch {} if (a.action !== 'exec_js' || true) { try { const sh = await svc.screenshot(scope(), true); fs.writeFileSync((process.env.QA_SHOTS || '/tmp/qa-shots')+'/s'+String(++shotN).padStart(2,'0')+'.png', Buffer.from(sh.data,'base64')); console.log('SHOT '+shotN+' after '+a.action); } catch(e) { console.log('SHOTERR '+String(e).slice(0,100)); } } return out; };
const tools = [bt, process.env.NOCHECKOUT ? createDoneTool() : createCheckoutTool({ page: createCheckoutPage(svc, scope), requireApproval: async (a, s) => { asks.push({ tool: 'checkout:' + a, approve: false, q: s.slice(0, 300) }); return false; }, maxAmountCents: 30000 }), createDoneTool()].filter((t, i, a) => a.findIndex((x) => x.name === t.name) === i);
const agent = await PersonalAgent.create(config, tools, gate, 'local', { sessionId: 'qa', desktop: false });
const calls = [];
const res = await agent.run(prompt, undefined, { onToolCall: (i) => calls.push(i.tool + ': ' + i.summary) });
console.log('=== TOOL CALLS\n' + calls.join('\n'));
console.log('=== ASKS\n' + JSON.stringify(asks, null, 1));
console.log('=== FINAL\n' + res.text + (res.error ? '\nERROR ' + res.error : ''));
let sel = ''; try { const r = await svc.execJs(scope(), "return await page.evaluate(() => { const m = document.getElementById('mine'); return m ? 'PRESENT:' + location.href + '|' + m.innerText : 'ABSENT:' + location.href; })"); sel = String(r.text); } catch {}
const goal = process.env.QA_GOAL_CITY || ''; const picks = state.picks; const lastPick = picks[picks.length - 1];
// Ground truth = the fixture SERVER's record of picks (survives browser/session loss). The DOM read of #mine is display only.
const verdict = !goal ? 'n/a' : !picks.length ? 'no-selection' : `${lastPick.name} - ${lastPick.addr}`.toLowerCase().includes(goal.toLowerCase()) ? 'ok' : 'FAIL';
console.log('=== ORACLE (external verdict, not product protection)\n' + JSON.stringify({ serverPicks: picks, domRead: sel.slice(0, 200), goal, verdict, note: 'verdict from server-side pick record; last pick counts; multiple picks listed' }));
console.log('=== SHOP STATE\n' + JSON.stringify({ cart: state.cart, payHits: state.payHits, reqs: state.log.length }));
await svc.closeAll?.();
process.exit(0);

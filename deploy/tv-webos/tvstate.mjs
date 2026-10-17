import { tvRequest } from '../../dist/tv/lgtv.js';
import { vaultGet } from '../../dist/vault.js';

const host = await vaultGet('tv:host');
const clientKey = await vaultGet('tv:clientKey');
const deps = { allowPlaintext: (await vaultGet('tv:secure')) === '0' };

for (const [label, uri, payload] of [
  ['power', 'com.webos.service.tvpower/power/getPowerState', {}],
  ['foreground', 'com.webos.applicationManager/getForegroundAppInfo', {}],
  ['running', 'com.webos.applicationManager/getRunningApps', {}],
]) {
  try {
    const res = await tvRequest(host, clientKey, uri, payload, deps);
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(res).slice(0, 900));
  } catch (err) {
    console.log(`\n=== ${label} === ERROR: ${err.message}`);
  }
}
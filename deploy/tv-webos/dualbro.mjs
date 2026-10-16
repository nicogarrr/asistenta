import { chromium } from 'playwright';

const TV_IP = process.argv[2] ?? process.env.TV_IP ?? '192.168.1.237';
const URL = 'https://e.nya.je/getroot/';

const context = await chromium.launchPersistentContext(process.env.DUALBRO_CHROME_PROFILE ?? 'C:\\Temp\\chrome-dualbro', {
  channel: 'chrome',
  headless: false,
args: [
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccessChecks',
  ],
});

const page = context.pages()[0] ?? await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });

console.log('abriendo', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('#connectBtn', { timeout: 30000 });

// Ajustes exactos del caso de Ã©xito en webOS 26 (OLED83G5WUA, 43.21.71)
await page.fill('#webosverion', '11.2');
await page.check('#advtoggle');
await page.selectOption('#whichbro', 'wtf');
await page.selectOption('#whichapp', 'auto');
await page.fill('#tvip', TV_IP);
await page.check('#ssltoggle');

const vals = await page.evaluate(() => ({
  version: document.querySelector('#webosverion')?.value,
  adv: document.querySelector('#advtoggle')?.checked,
  payload: document.querySelector('#whichbro')?.value,
  entry: document.querySelector('#whichapp')?.value,
  ip: document.querySelector('#tvip')?.value,
  ssl: document.querySelector('#ssltoggle')?.checked,
}));
console.log('formulario:', JSON.stringify(vals));

console.log('>>> PULSANDO ROOT. ACEPTA EL DIALOGO EN LA TV CON EL MANDO <<<');
const clicked = await page.evaluate(() => {
  const b = document.querySelector('#connectBtn');
  if (!b) return 'no-button';
  b.click();
  return `clicked disabled=${b.disabled}`;
});
console.log('click:', clicked);

// El log vive en <pre id="log">. Lo volcamos en vivo.
let last = '';
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  const text = await page.locator('#log').innerText().catch(() => '');
  if (text !== last) {
    const fresh = text.slice(last.length);
    if (fresh.trim()) process.stdout.write(fresh);
    last = text;
  }
  const status = await page.locator('#statusText').innerText().catch(() => '');
  if (/done|complete|success|rooted|reboot/i.test(status)) {
    console.log('\n[status final]', status);
    break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}

console.log('\n--- LOG COMPLETO ---');
console.log(await page.locator('#log').innerText().catch(() => '(sin log)'));
await context.close();

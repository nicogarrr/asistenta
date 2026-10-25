import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callPageScan, installPageScan } from '../src/browser/inpage.js';
import { formatSnapshot, type PageScan } from '../src/browser/service.js';

// Un snapshot es una acción GRATIS (no pide permiso): si filtra el valor de una
// contraseña, una tarjeta o un código de un solo uso, ese secreto viaja al
// proveedor del modelo y queda en la transcripción sin que nadie lo apruebe.
// La página solo debe saber si el campo está relleno, nunca qué contiene.
describe('snapshot del navegador sin secretos', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });

  it('enmascara contraseña, tarjeta, OTP y ocultos, y deja leer lo normal', async () => {
    page = await browser.newPage();
    await page.setContent(`
      <form>
        <label for="u">Usuario</label>
        <input id="u" name="user" value="nico">
        <label for="p">Contraseña</label>
        <input id="p" type="password" name="password" value="S3cr3t!">
        <label for="c">Tarjeta</label>
        <input id="c" autocomplete="cc-number" value="4111111111111111">
        <label for="o">Código</label>
        <input id="o" autocomplete="one-time-code" value="654321">
        <input type="hidden" name="token" value="tok_secreto_123">
      </form>
    `);
    await installPageScan(page);
    const scan = await callPageScan<{ max: number }, PageScan>(page, { max: 50 });
    const text = formatSnapshot(scan);

    expect(text).toContain('nico');
    expect(text).not.toContain('S3cr3t!');
    expect(text).not.toContain('4111111111111111');
    expect(text).not.toContain('654321');
    expect(text).not.toContain('tok_secreto_123');
    expect(text).toContain('[sensible]');
    expect(text).toContain('value="***"');
  });
});

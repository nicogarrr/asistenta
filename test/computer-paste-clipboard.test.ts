import { describe, expect, it } from 'vitest';
import { WindowsScreen } from '../src/screen/windows.js';

/**
 * Pegar por portapapeles (emojis, acentos raros, llaves). Antes: si Nico tenía
 * copiada una IMAGEN o unos ficheros, al escribir un emoji el portapapeles
 * quedaba vacío (`Set-Clipboard -Value ''`) y perdía lo copiado; y se devolvía
 * el contenido viejo a los 200 ms fijos, así que una app lenta (Electron) podía
 * pegar lo viejo en vez del texto. Ahora se copia cada formato y se devuelve solo
 * cuando la app ha terminado, y nunca encima de algo nuevo.
 */
async function scriptsFor(text: string, env?: Record<string, string>): Promise<string[]> {
  const scripts: string[] = [];
  const prev = process.env.PA_COMPUTER_PASTE_SETTLE_MS;
  if (env?.PA_COMPUTER_PASTE_SETTLE_MS !== undefined)
    process.env.PA_COMPUTER_PASTE_SETTLE_MS = env.PA_COMPUTER_PASTE_SETTLE_MS;
  else delete process.env.PA_COMPUTER_PASTE_SETTLE_MS;
  try {
    const screen = new WindowsScreen(async (script) => {
      scripts.push(script);
      return { stdout: '', stderr: '' };
    });
    await screen.type(text);
  } finally {
    if (prev === undefined) delete process.env.PA_COMPUTER_PASTE_SETTLE_MS;
    else process.env.PA_COMPUTER_PASTE_SETTLE_MS = prev;
  }
  return scripts;
}

describe('computer · portapapeles al pegar', () => {
  it('el texto sigue viajando en base64 y se pega con Ctrl+V (caracterización)', async () => {
    const script = (await scriptsFor('❤'))[0] ?? '';
    expect(script).toContain(Buffer.from('❤', 'utf8').toString('base64'));
    expect(script).toContain("SendWait('^v')");
  });

  it('un portapapeles con imagen o ficheros no se vacía: se guardan todos los formatos', async () => {
    const script = (await scriptsFor('❤'))[0] ?? '';
    expect(script).not.toMatch(/Set-Clipboard -Value ''/);
    expect(script).toContain('GetDataObject()');
    expect(script).toContain('GetFormats($false)');
    expect(script).toContain('SetDataObject($saved, $true)');
  });

  it('se devuelve solo tras esperar a la app y si el portapapeles aún es nuestro texto', async () => {
    const script = (await scriptsFor('❤'))[0] ?? '';
    const paste = script.indexOf("SendWait('^v')");
    const idle = script.indexOf('WaitForInputIdle');
    const restore = script.indexOf('SetDataObject($saved');
    expect(idle).toBeGreaterThan(paste);
    expect(restore).toBeGreaterThan(idle);
    expect(script).toContain('-ceq $text');
    expect(script).toMatch(/if \(\$stillOurs\)/);
  });

  it('espera 400 ms por defecto, configurable con PA_COMPUTER_PASTE_SETTLE_MS y acotada', async () => {
    expect((await scriptsFor('❤'))[0]).toContain('Start-Sleep -Milliseconds 400');
    expect((await scriptsFor('❤', { PA_COMPUTER_PASTE_SETTLE_MS: '1500' }))[0]).toContain(
      'Start-Sleep -Milliseconds 1500',
    );
    expect((await scriptsFor('❤', { PA_COMPUTER_PASTE_SETTLE_MS: '999999' }))[0]).toContain(
      'Start-Sleep -Milliseconds 5000',
    );
    expect((await scriptsFor('❤', { PA_COMPUTER_PASTE_SETTLE_MS: '5' }))[0]).toContain(
      'Start-Sleep -Milliseconds 100',
    );
    expect((await scriptsFor('❤', { PA_COMPUTER_PASTE_SETTLE_MS: 'abc' }))[0]).toContain(
      'Start-Sleep -Milliseconds 400',
    );
  });

  it('el texto ASCII sigue yendo por SendKeys, sin tocar el portapapeles', async () => {
    const scripts = await scriptsFor('hola');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toContain('Clipboard');
  });
});

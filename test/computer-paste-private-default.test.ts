import { describe, expect, it } from 'vitest';
import { pasteNoHistory, pasteScript } from '../src/screen/windows.js';

/**
 * Nico (16:47): el pegado de Computer Use usa por defecto la opción más privada (fuera del
 * historial Win+V y de la nube), pero con respaldo: si Windows no la admite, se pega igual
 * que hoy. No se ejecuta PowerShell: se comprueba el script que se generaría.
 */
const B64 = Buffer.from('hola 😀').toString('base64');

describe('pegado privado por defecto con respaldo', () => {
  it('por defecto (sin variable) el pegado es privado', () => {
    expect(pasteNoHistory({})).toBe(true);
    expect(pasteNoHistory({ PA_COMPUTER_PASTE_NO_HISTORY: '' })).toBe(true);
  });

  it('PA_COMPUTER_PASTE_NO_HISTORY=0 vuelve al pegado simple de siempre', () => {
    expect(pasteNoHistory({ PA_COMPUTER_PASTE_NO_HISTORY: '0' })).toBe(false);
    expect(pasteNoHistory({ PA_COMPUTER_PASTE_NO_HISTORY: ' 0 ' })).toBe(false);
    const plain = pasteScript(B64, 400, false);
    expect(plain).toContain('[System.Windows.Forms.Clipboard]::SetText($text)');
    expect(plain).not.toContain('CanIncludeInClipboardHistory');
    expect(plain).not.toContain('$privateSet');
  });

  it('si el pegado privado falla, cae al pegado simple (mismo SetText de hoy)', () => {
    const s = pasteScript(B64, 400, true);
    const tryAt = s.indexOf('try {\n$zero');
    const privateAt = s.indexOf('SetDataObject($do, $true)');
    const okAt = s.indexOf('$privateSet = $true');
    const catchAt = s.indexOf('} catch {}', okAt);
    const fallbackAt = s.indexOf(
      'if (-not $privateSet) { Pa-Retry { [System.Windows.Forms.Clipboard]::SetText($text) }',
    );
    expect(tryAt).toBeGreaterThan(-1);
    expect(privateAt).toBeGreaterThan(tryAt);
    expect(okAt).toBeGreaterThan(privateAt);
    expect(catchAt).toBeGreaterThan(okAt);
    expect(fallbackAt).toBeGreaterThan(catchAt);
    // El resto del pegado (Ctrl+V y restaurar el portapapeles) no cambia.
    expect(s.indexOf("SendWait('^v')")).toBeGreaterThan(fallbackAt);
    expect(s).toContain('$stillOurs');
  });
});

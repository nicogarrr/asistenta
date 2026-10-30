import { describe, expect, it } from 'vitest';
import { pasteNoHistory, pasteScript, WindowsScreen } from '../src/screen/windows.js';

const P = Buffer.from('hola 😀', 'utf8').toString('base64');
const PLAIN = 'Pa-Retry { [System.Windows.Forms.Clipboard]::SetText($text) } | Out-Null';

describe('paste: optional exclusion from Win+V history', () => {
  it('characterization: default paste script is unchanged (plain SetText, no history formats)', () => {
    const s = pasteScript(P, 400);
    expect(s).toBe(pasteScript(P, 400, false));
    expect(s).toContain(PLAIN);
    expect(s).not.toContain('CanIncludeInClipboardHistory');
  });

  it('the flag is off unless PA_COMPUTER_PASTE_NO_HISTORY=1', () => {
    expect(pasteNoHistory({})).toBe(false);
    expect(pasteNoHistory({ PA_COMPUTER_PASTE_NO_HISTORY: '0' })).toBe(false);
    expect(pasteNoHistory({ PA_COMPUTER_PASTE_NO_HISTORY: 'true' })).toBe(false);
    expect(pasteNoHistory({ PA_COMPUTER_PASTE_NO_HISTORY: '1' })).toBe(true);
  });

  it('with the flag our text goes in a DataObject marked out of history, cloud and monitors', () => {
    const s = pasteScript(P, 400, true);
    expect(s).not.toContain(PLAIN);
    for (const f of [
      'CanIncludeInClipboardHistory',
      'CanUploadToCloudClipboard',
      'ExcludeClipboardContentFromMonitorProcessing',
    ])
      expect(s).toContain(`$do.SetData('${f}'`);
    expect(s).toContain('$do.SetText($text)');
    expect(s).toContain('SetDataObject($do, $true)');
    // the snapshot/restore of Nico's own clipboard (#467) is still there
    expect(s).toContain('GetDataObject()');
    expect(s).toContain('SetDataObject($saved, $true)');
  });

  it('WindowsScreen.type honours the env flag on the paste path', async () => {
    const prev = process.env.PA_COMPUTER_PASTE_NO_HISTORY;
    const calls: string[] = [];
    const run = async (sc: string) => {
      calls.push(sc);
      return { stdout: '', stderr: '' };
    };
    try {
      process.env.PA_COMPUTER_PASTE_NO_HISTORY = '1';
      await new WindowsScreen(run).type('😀');
      expect(calls.some((c) => c.includes('CanIncludeInClipboardHistory'))).toBe(true);
      calls.length = 0;
      delete process.env.PA_COMPUTER_PASTE_NO_HISTORY;
      await new WindowsScreen(run).type('😀');
      expect(calls.some((c) => c.includes('CanIncludeInClipboardHistory'))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PA_COMPUTER_PASTE_NO_HISTORY;
      else process.env.PA_COMPUTER_PASTE_NO_HISTORY = prev;
    }
  });
});

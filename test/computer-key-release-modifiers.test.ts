import { describe, expect, it } from 'vitest';
import { MODIFIER_VKS, releaseModifiersScript, WindowsScreen } from '../src/screen/windows.js';

function runner(fail: (script: string, n: number) => Error | null) {
  const calls: string[] = [];
  const run = async (script: string) => {
    calls.push(script);
    const err = fail(script, calls.length);
    if (err) throw err;
    return { stdout: '', stderr: '' };
  };
  return { calls, run };
}

describe('key(): modifiers are released after a failed chord', () => {
  it('characterization: a successful chord is one PowerShell call, nothing extra', async () => {
    for (const k of ['win+r', 'ctrl+c', 'alt+tab', 'enter']) {
      const r = runner(() => null);
      await new WindowsScreen(r.run).key(k);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]).not.toContain('GetAsyncKeyState');
    }
  });

  it('a Win chord killed by the timeout releases held modifiers and rethrows the original error', async () => {
    const boom = new Error('PowerShell no respondió en 30 s y se cortó');
    const r = runner((_s, n) => (n === 1 ? boom : null));
    await expect(new WindowsScreen(r.run).key('win+r')).rejects.toBe(boom);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toBe(releaseModifiersScript());
  });

  it('a SendKeys chord (ctrl+shift+esc) that fails also releases', async () => {
    const boom = new Error('x');
    const r = runner((_s, n) => (n === 1 ? boom : null));
    await expect(new WindowsScreen(r.run).key('ctrl+shift+esc')).rejects.toBe(boom);
    expect(r.calls[1]).toContain('GetAsyncKeyState');
  });

  it('a failing release never hides the original error', async () => {
    const r = runner((_s, n) => new Error(n === 1 ? 'original' : 'release failed too'));
    await expect(new WindowsScreen(r.run).key('win+d')).rejects.toThrow('original');
    expect(r.calls).toHaveLength(2);
  });

  it('the release script only lifts keys Windows reports as down, and masks a lone Win key-up', () => {
    const s = releaseModifiersScript();
    for (const vk of [0x5b, 0x5c, 0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]) {
      expect(MODIFIER_VKS).toContain(vk);
      expect(s).toContain(`0x${vk.toString(16).padStart(2, '0')}`);
    }
    expect(s).toMatch(/GetAsyncKeyState\(\$_\) -band 0x8000/);
    // key-up only (flag 2) for the held list; no key-down of any modifier
    expect(s).toMatch(/foreach \(\$vk in \$held\) \{ \[R\]::keybd_event\(\[byte\]\$vk,0,2,/);
    expect(s).not.toMatch(/keybd_event\(\[byte\]\$vk,0,0,/);
    expect(s.indexOf('0xe8,0,0')).toBeGreaterThan(-1);
    expect(s.indexOf('0xe8,0,0')).toBeLessThan(s.indexOf('foreach ($vk in $held)'));
  });
});

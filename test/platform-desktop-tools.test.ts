import { describe, expect, it } from 'vitest';
import { DESKTOP_ONLY_TOOLS, toolsForMode } from '../src/platform.js';
import type { IphoneToolDeps } from '../src/tools/iphone.js';
import { createIphoneTool } from '../src/tools/iphone.js';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool } from '../src/tools/tv.js';

const tool = (name: string) => ({ name });

describe('desktop-only tools', () => {
  it('tv and iphone are desktop-only: server mode never offers them', () => {
    expect(DESKTOP_ONLY_TOOLS.has('tv')).toBe(true);
    expect(DESKTOP_ONLY_TOOLS.has('iphone')).toBe(true);
    const all = [tool('read'), tool('tv'), tool('iphone'), tool('computer')];
    expect(toolsForMode(all, false).map((t) => t.name)).toEqual(['read']);
    expect(toolsForMode(all, true).map((t) => t.name)).toEqual([
      'read',
      'tv',
      'iphone',
      'computer',
    ]);
  });

  it('the set names match the tool names the factories actually register', () => {
    // A rename in either factory without updating the set would silently
    // re-expose the tool in server mode; this canary pins both sides.
    const tv = createTvTool({} as unknown as TvToolDeps);
    const iphone = createIphoneTool({} as unknown as IphoneToolDeps);
    expect(DESKTOP_ONLY_TOOLS.has(tv.name)).toBe(true);
    expect(DESKTOP_ONLY_TOOLS.has(iphone.name)).toBe(true);
  });
});

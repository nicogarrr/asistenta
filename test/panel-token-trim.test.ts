import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { panelDoctorLines, panelTokenFromEnv } from '../src/panel-doctor.js';

describe('token del panel con espacios o \\r de Windows', () => {
  it('se recorta igual en el daemon que en el doctor', () => {
    expect(panelTokenFromEnv({ PA_WEB_TOKEN: '  abcdefghijklmnopqrstuvwxyz\r\n' })).toBe(
      'abcdefghijklmnopqrstuvwxyz',
    );
    expect(panelTokenFromEnv({ PA_WEB_TOKEN: '   ' })).toBe('');
    expect(panelTokenFromEnv({})).toBe('');
    expect(panelDoctorLines({ PA_WEB_PORT: '8787', PA_WEB_TOKEN: ' \r' })[0]).toContain(
      'falta PA_WEB_TOKEN',
    );
  });

  it('el daemon arranca el panel con el token recortado, no con el crudo', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    // El token sale de panelStartPlan, que usa panelTokenFromEnv (recortado).
    expect(cli).toContain('const webToken = panelPlan.token;');
    expect(cli).not.toMatch(/const webToken = process\.env\.PA_WEB_TOKEN;/);
  });
});

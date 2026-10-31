import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { panelDoctorLines, panelStartPlan } from '../src/panel-doctor.js';

// Primer uso en Windows: el panel se activa con PA_WEB_PORT y PA_WEB_TOKEN en .env.
// El daemon no comprobaba el puerto (pa doctor sí) y, sin token, solo dejaba una
// línea técnica «PA_WEB_PORT sin PA_WEB_TOKEN» en el log.
describe('panel: arranque desde el daemon', () => {
  it('sin PA_WEB_PORT (o solo espacios) el panel está apagado y no avisa', () => {
    expect(panelStartPlan({}).kind).toBe('off');
    expect(panelStartPlan({ PA_WEB_PORT: '  ' }).kind).toBe('off');
  });

  it('un puerto que no es número dice qué poner, en castellano llano', () => {
    for (const port of ['abc', '80a', '0', '70000', '8787.5']) {
      const r = panelStartPlan({ PA_WEB_PORT: port, PA_WEB_TOKEN: 'x'.repeat(30) });
      expect(r.kind).toBe('problem');
      if (r.kind !== 'problem') continue;
      expect(r.message).toContain(`PA_WEB_PORT=${port} no es un puerto válido`);
      expect(r.message).toContain('PA_WEB_PORT=8787');
      expect(r.message).toContain('reinicia Asistenta');
      // pa doctor dice lo mismo
      expect(panelDoctorLines({ PA_WEB_PORT: port })[0]).toContain('no es un puerto válido');
    }
  });

  it('sin token dice qué añadir a .env, sin jerga', () => {
    for (const token of [undefined, '', '  \r']) {
      const r = panelStartPlan({ PA_WEB_PORT: '8787', PA_WEB_TOKEN: token });
      expect(r.kind).toBe('problem');
      if (r.kind !== 'problem') continue;
      expect(r.message).toMatch(/^El panel web no se ha encendido: falta PA_WEB_TOKEN en \.env\./);
      expect(r.message).toContain('24 o más letras y números al azar');
      expect(r.message).not.toMatch(/sin PA_WEB_TOKEN|arrancado/);
    }
  });

  it('con puerto y token arranca con el número y el token recortado', () => {
    expect(panelStartPlan({ PA_WEB_PORT: ' 8787\r', PA_WEB_TOKEN: ' abc\r' })).toEqual({
      kind: 'start',
      port: 8787,
      token: 'abc',
    });
  });

  it('el daemon usa esta comprobación y ya no deja la línea técnica', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('panelStartPlan()');
    expect(cli).not.toContain('PA_WEB_PORT sin PA_WEB_TOKEN');
    expect(cli).not.toContain('Number(process.env.PA_WEB_PORT)');
  });
});

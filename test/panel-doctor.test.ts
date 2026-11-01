import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { panelDoctorLines } from '../src/panel-doctor.js';

const TOKEN = 'a'.repeat(32);

describe('F14: pa doctor sobre el panel web', () => {
  it('sin PA_WEB_PORT: encendido en 8787 con token automático; PA_WEB_PORT=0 lo apaga', () => {
    expect(panelDoctorLines({})).toEqual([
      'panel web       http://127.0.0.1:8787 (solo este PC; ábrelo con «pa panel»)',
      'panel token     automático, guardado en la carpeta de estado (PA_WEB_TOKEN lo cambia)',
    ]);
    expect(panelDoctorLines({ PA_WEB_PORT: '0' })).toEqual([
      'panel web       off (PA_WEB_PORT=0 en .env; quita esa línea para encenderlo)',
    ]);
  });
  it('puerto raro: dice que no arranca; sin token usa el automático', () => {
    expect(panelDoctorLines({ PA_WEB_PORT: '80a', PA_WEB_TOKEN: TOKEN })[0]).toContain(
      'NO ARRANCA',
    );
    expect(panelDoctorLines({ PA_WEB_PORT: '70000', PA_WEB_TOKEN: TOKEN })[0]).toContain(
      'NO ARRANCA',
    );
    expect(panelDoctorLines({ PA_WEB_PORT: '8787' })[1]).toContain('panel token     automático');
  });
  it('loopback con token largo y sin hosts extra: una línea, sin avisos', () => {
    expect(panelDoctorLines({ PA_WEB_PORT: '8787', PA_WEB_TOKEN: TOKEN })).toEqual([
      'panel web       http://127.0.0.1:8787 (solo este PC; ábrelo con «pa panel»)',
    ]);
  });
  it('token corto avisa', () => {
    const l = panelDoctorLines({ PA_WEB_PORT: '8787', PA_WEB_TOKEN: 'abc' });
    expect(l[1]).toMatch(/^panel token +CORTO \(3 caracteres\)/);
  });
  it('Tailscale ok; otro proxy y comodines avisan', () => {
    const l = panelDoctorLines({
      PA_WEB_PORT: '8787',
      PA_WEB_TOKEN: TOKEN,
      PA_WEB_ALLOWED_HOSTS: 'mi-pc.red.ts.net, *.ejemplo.es, panel.ejemplo.es',
    });
    expect(l).toContain(
      'panel hosts     comodines ignorados en PA_WEB_ALLOWED_HOSTS: cada nombre va exacto',
    );
    expect(l).toContain('panel remoto    mi-pc.red.ts.net (Tailscale: solo tus dispositivos)');
    expect(l.find((x) => x.includes('panel.ejemplo.es'))).toContain('OJO, no es de Tailscale');
  });
  it('pa doctor las incluye y .env.example dice que el token se genera si falta', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toMatch(/lines\.push\(\.\.\.panelDoctorLines\(\)\)/);
    const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    expect(env).toMatch(/si falta se genera uno/);
  });
});

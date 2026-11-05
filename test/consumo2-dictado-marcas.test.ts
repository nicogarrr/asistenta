import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arrancarDictado, MARCA_ACTIVO, MARCA_GRABANDO } from '../src/dictado/arranque.js';

// Consumo: la bandeja miraba cada segundo `dictado.grabando`, que nadie escribía (1 despertar/s
// todo el día). Ahora el daemon marca `dictado.activo` con el dictado encendido y
// `dictado.grabando` mientras graba, y la bandeja solo mira cada segundo con el dictado activo.
const tray = readFileSync('scripts/windows-app/bandeja.ps1', 'utf8');

describe('consumo: la bandeja no se despierta cada segundo sin dictado', () => {
  it('el temporizador de 1 s solo arranca con dictado.activo', () => {
    expect(tray).toContain("$dictadoActivo = Join-Path $stateDir 'dictado.activo'");
    const starts = [...tray.matchAll(/\$rapido\.Start\(\)/g)];
    expect(starts).toHaveLength(1);
    const fn = tray.slice(tray.indexOf('function Update-Dictado'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('$rapido.Start()');
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('$rapido.Stop()');
    // el de 60 s (que ya existía) es el que lo enciende o apaga
    expect(tray).toContain('$lento.add_Tick({ Update-Estado; Update-Dictado })');
    expect(tray).not.toMatch(/Get-Content[^\n]*(grabando|dictadoActivo)/);
  });
});

describe('consumo: el dictado deja las marcas para la bandeja', () => {
  const piezas = (avisos: string[], t: { pulsar: () => void; soltar: () => void }) => async () => ({
    tecla: {
      start: async (p: () => void, s: () => void) => {
        t.pulsar = p;
        t.soltar = s;
      },
      stop: async () => {},
    },
    capture: { start: async () => {}, stop: async () => {} },
    escritor: { campoSeguro: async () => false, escribir: async () => {} },
    avisar: (a: string) => void avisos.push(a),
  });

  it('activo al arrancar, grabando mientras graba, nada al parar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'consumo2-dictado-'));
    const avisos: string[] = [];
    const t = { pulsar: () => {}, soltar: () => {} };
    const d = await arrancarDictado({
      env: { PA_DICTADO: '1' },
      plataforma: 'win32',
      piezas: piezas(avisos, t),
      transcribir: async () => '',
      dirMarcas: dir,
    });
    expect(d).not.toBeNull();
    expect(existsSync(join(dir, MARCA_ACTIVO))).toBe(true);
    expect(existsSync(join(dir, MARCA_GRABANDO))).toBe(false);
    t.pulsar();
    await d?.enCurso;
    expect(existsSync(join(dir, MARCA_GRABANDO))).toBe(true);
    t.soltar();
    await d?.enCurso;
    expect(existsSync(join(dir, MARCA_GRABANDO))).toBe(false);
    expect(avisos).toEqual(['graba', 'fin']); // los avisos de siempre siguen llegando
    await d?.stop();
    expect(existsSync(join(dir, MARCA_ACTIVO))).toBe(false);
  });

  it('sin PA_DICTADO borra las marcas que quedaran de antes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'consumo2-dictado-'));
    writeFileSync(join(dir, MARCA_ACTIVO), '');
    writeFileSync(join(dir, MARCA_GRABANDO), '');
    expect(await arrancarDictado({ env: {}, dirMarcas: dir })).toBeNull();
    expect(existsSync(join(dir, MARCA_ACTIVO))).toBe(false);
    expect(existsSync(join(dir, MARCA_GRABANDO))).toBe(false);
  });
});

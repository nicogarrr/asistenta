/**
 * Primer uso en Windows: `pa doctor` mezclaba etiquetas en inglés («provider key»,
 * «browser FALTA», «verify actions», «shell sandbox») con el resto en castellano.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorLineEs, doctorLinesEs } from '../src/doctor-labels.js';

const ENGLISH =
  /^(state dir|vault|provider key|shell|screen|screenshot|screen video|voice stt|voice tts|camera|microphone|wake word|desktop|shell sandbox|sandbox image|browser|cron|verify actions|open windows|panel hosts|mcp http) {2,}/m;

describe('pa doctor en castellano', () => {
  it('traduce las etiquetas y deja el valor igual, en la misma columna', () => {
    expect(doctorLineEs('provider key    sin poner (instalar.bat)')).toBe(
      'clave modelo    sin poner (instalar.bat)',
    );
    expect(doctorLineEs('browser         FALTA (ejecuta: npx playwright install chromium)')).toBe(
      'navegador       FALTA (ejecuta: npx playwright install chromium)',
    );
    expect(doctorLineEs('verify actions  desactivado')).toBe('comprobar       desactivado');
    expect(doctorLineEs('state dir       C:\\Users\\Ana\\.asistenta')).toBe(
      'datos           C:\\Users\\Ana\\.asistenta',
    );
    expect(doctorLineEs('shell sandbox   off (la shell corre en el PC)')).toBe(
      'consola aislada apagado (la shell corre en el PC)',
    );
    expect(doctorLineEs('desktop         off (modo servidor, PA_DESKTOP=off)')).toBe(
      'escritorio      apagado (modo servidor, PA_DESKTOP=off)',
    );
  });

  it('un «off» inicial pasa a «apagado» aunque la etiqueta ya sea castellana', () => {
    expect(doctorLineEs('panel web       off (PA_WEB_PORT y PA_WEB_TOKEN para activarlo)')).toBe(
      'panel web       apagado (PA_WEB_PORT y PA_WEB_TOKEN para activarlo)',
    );
    expect(doctorLineEs('panel web       offline raro')).toBe('panel web       offline raro');
  });

  it('lo que ya está en castellano o no es una línea de etiqueta no cambia', () => {
    for (const line of [
      'node            v24.1.0',
      'carpeta         C:\\Asistenta',
      'panel web       http://127.0.0.1:8787 (solo este PC)',
      'mcp recursos    apagado (PA_MCP_RESOURCES=1 para activarlo)',
      'texto suelto sin columnas',
      '',
    ])
      expect(doctorLineEs(line)).toBe(line);
  });

  it('ninguna etiqueta conocida sigue en inglés', () => {
    const labels = [
      'state dir',
      'vault',
      'provider key',
      'shell',
      'screen',
      'screenshot',
      'screen video',
      'voice stt',
      'voice tts',
      'camera',
      'microphone',
      'wake word',
      'desktop',
      'shell sandbox',
      'sandbox image',
      'browser',
      'cron',
      'verify actions',
      'open windows',
      'panel hosts',
      'mcp http',
    ];
    const out = doctorLinesEs(labels.map((l) => `${l.padEnd(15)} x`)).join('\n');
    expect(out).not.toMatch(ENGLISH);
    for (const l of out.split('\n')) expect(l.indexOf(' x')).toBe(15);
  });

  it('pa doctor usa la traducción', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain('process.stdout.write(`${doctorLinesEs(lines).join');
  });

  it.skipIf(process.platform !== 'linux')('el doctor compilado sale en castellano', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-doctor-es-'));
    try {
      const r = spawnSync(process.execPath, [resolve('dist/cli.js'), 'doctor'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          PA_STATE_DIR: dir,
          PA_DESKTOP: 'off',
          NO_COLOR: '1',
          FORCE_COLOR: '',
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('clave modelo');
      expect(r.stdout).toContain('navegador');
      expect(r.stdout).not.toMatch(ENGLISH);
      expect(r.stdout).not.toMatch(/^\S.* {2,}off\b/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

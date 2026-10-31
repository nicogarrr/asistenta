/**
 * Nico (31 oct): «Actívalo por defecto». El panel web se enciende sin tocar el .env:
 * 127.0.0.1:8787 y un token al azar guardado en el estado (solo lo lee el usuario).
 * PA_WEB_PORT=0 lo apaga; un PA_WEB_TOKEN puesto gana. `pa panel` (y «Abrir panel» en
 * la bandeja) lo abre ya con el token, sin imprimirlo nunca.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { panelCommand } from '../src/panel-abrir.js';
import {
  panelBootFacts,
  panelDoctorLines,
  panelListenProblem,
  panelStartPlan,
} from '../src/panel-doctor.js';
import { ensurePanelToken, panelTokenPath } from '../src/panel-token.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function stateDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pa-panel-defecto-'));
  dirs.push(d);
  return d;
}

describe('panel web activado por defecto', () => {
  it('sin PA_WEB_PORT ni PA_WEB_TOKEN arranca en 127.0.0.1:8787 con el token guardado', () => {
    const plan = panelStartPlan({}, () => 'g'.repeat(43));
    expect(plan).toEqual({
      kind: 'start',
      port: 8787,
      token: 'g'.repeat(43),
      porDefecto: true,
      tokenAuto: true,
    });
  });

  it('PA_WEB_PORT=0 lo apaga; un PA_WEB_TOKEN puesto gana al guardado', () => {
    const stored = vi.fn(() => 'g'.repeat(43));
    expect(panelStartPlan({ PA_WEB_PORT: '0' }, stored).kind).toBe('off');
    expect(panelStartPlan({ PA_WEB_PORT: 'off' }, stored).kind).toBe('off');
    expect(panelStartPlan({ PA_WEB_TOKEN: 'mio'.repeat(10) }, stored)).toEqual({
      kind: 'start',
      port: 8787,
      token: 'mio'.repeat(10),
      porDefecto: true,
    });
    expect(stored).not.toHaveBeenCalled();
  });

  it('si no se puede guardar el token, no arranca y dice qué hacer (sin tumbar el arranque)', () => {
    const plan = panelStartPlan({}, () => {
      throw new Error('EACCES');
    });
    expect(plan.kind).toBe('problem');
    if (plan.kind !== 'problem') return;
    expect(plan.problem).toBe('panel-token');
    expect(plan.message).toContain('no he podido guardar su token');
    expect(plan.message).not.toContain('EACCES');
  });

  it('el token se crea una vez, al azar, solo para el usuario, y se reutiliza', () => {
    const dir = stateDir();
    const a = ensurePanelToken(dir);
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(ensurePanelToken(dir)).toBe(a);
    expect(ensurePanelToken(stateDir())).not.toBe(a);
    if (process.platform !== 'win32') {
      expect(statSync(panelTokenPath(dir)).mode & 0o777).toBe(0o600);
    }
    // Uno guardado demasiado corto no vale: se cambia por uno nuevo.
    writeFileSync(panelTokenPath(dir), 'corto\n');
    const b = ensurePanelToken(dir);
    expect(b).toMatch(/^[\w-]{43}$/);
    expect(readFileSync(panelTokenPath(dir), 'utf8').trim()).toBe(b);
  });

  it('puerto por defecto ocupado: solo la línea de la consola, sin aviso por Telegram', async () => {
    const busy = panelListenProblem(Object.assign(new Error('x'), { code: 'EADDRINUSE' }), 8787);
    const porDefecto = panelStartPlan({}, () => 'g'.repeat(43));
    expect(await panelBootFacts(porDefecto, Promise.resolve(busy))).toEqual({ problems: [] });
    const pedido = panelStartPlan({ PA_WEB_PORT: '8787' }, () => 'g'.repeat(43));
    expect(await panelBootFacts(pedido, Promise.resolve(busy))).toEqual({
      problems: ['panel-ocupado'],
    });
  });

  it('pa doctor dice que está encendido y cómo abrirlo', () => {
    expect(panelDoctorLines({}).join('\n')).toContain('http://127.0.0.1:8787');
    expect(panelDoctorLines({}).join('\n')).toContain('pa panel');
  });
});

describe('pa panel', () => {
  it('abre 127.0.0.1 con el token en la dirección y no lo imprime', async () => {
    const dir = stateDir();
    const open = vi.fn(async (_url: string) => true);
    const lines: string[] = [];
    expect(await panelCommand({ env: {}, stateDir: dir, open, print: (l) => lines.push(l) })).toBe(
      0,
    );
    const token = readFileSync(panelTokenPath(dir), 'utf8').trim();
    expect(open).toHaveBeenCalledWith(`http://127.0.0.1:8787/?token=${token}`);
    expect(lines.join('\n')).toContain('http://127.0.0.1:8787/');
    expect(lines.join('\n')).not.toContain(token);
  });

  it('con PA_WEB_PORT y PA_WEB_TOKEN propios usa esos', async () => {
    const open = vi.fn(async (_url: string) => true);
    const env = { PA_WEB_PORT: '8790', PA_WEB_TOKEN: 'propio'.repeat(5) };
    expect(await panelCommand({ env, stateDir: stateDir(), open, print: () => {} })).toBe(0);
    expect(open).toHaveBeenCalledWith(`http://127.0.0.1:8790/?token=${'propio'.repeat(5)}`);
  });

  it('apagado o sin navegador: lo dice y no enseña el token', async () => {
    const lines: string[] = [];
    const print = (l: string) => lines.push(l);
    const open = vi.fn(async (_url: string) => false);
    expect(
      await panelCommand({ env: { PA_WEB_PORT: '0' }, stateDir: stateDir(), open, print }),
    ).toBe(1);
    expect(lines[0]).toContain('El panel está apagado');
    expect(open).not.toHaveBeenCalled();
    const dir = stateDir();
    expect(await panelCommand({ env: {}, stateDir: dir, open, print })).toBe(1);
    const token = readFileSync(panelTokenPath(dir), 'utf8').trim();
    expect(lines[1]).toContain('No he podido abrir el navegador');
    expect(lines.join('\n')).not.toContain(token);
  });

  it('el daemon y la bandeja usan esto', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toContain('panelStartPlan(process.env, () => ensurePanelToken(paths.state))');
    expect(cli).toContain("case 'panel': {");
    const tray = readFileSync('scripts/windows-app/bandeja.ps1', 'utf8');
    expect(tray).toContain('Invoke-Pa $Ordenes.Panel');
  });
});

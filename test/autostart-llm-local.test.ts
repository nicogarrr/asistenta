import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_LLM_CONTAINER,
  localLlmContainerRunning,
  unusedLocalLlmDoctorLine,
} from '../src/docker-local.js';

/**
 * Nico (2 nov): va por la nube, pero cada arranque abría Docker Desktop (hasta 45 s) y el
 * contenedor «asistenta-opencode». Solo PA_PROVIDER_PRESET=opencode-local lo usa.
 */
const dir = join('deploy', 'windows');
const read = (f: string) => readFileSync(join(dir, f), 'utf8');

describe('Docker/OpenCode local solo con opencode-local', () => {
  it('run-stack pasa el preset efectivo y Start-OptionalOpenCode no toca Docker sin él', () => {
    expect(read('run-stack.ps1')).toContain(
      '$llm=Start-OptionalOpenCode $EnableLocalLlm (Get-ProviderPreset $RepoDir $NodeExe)',
    );
    const core = read('autostart-core.ps1');
    const fn = core.slice(core.indexOf('function Start-OptionalOpenCode'));
    const disabled = fn.indexOf("if(-not $Enabled){return 'disabled'}");
    const cloud = fn.indexOf("if($Preset -ne 'opencode-local'){return 'not-configured'}");
    const docker = fn.indexOf('Get-Command docker.exe');
    // -EnableLocalLlm:$false gana; después, la nube vuelve antes de buscar Docker.
    expect(disabled).toBeGreaterThan(0);
    expect(cloud).toBeGreaterThan(disabled);
    expect(docker).toBeGreaterThan(cloud);
    // El preset lo resuelve resolve-preset.mjs (reglas de instalar.mjs) en la carpeta de la app;
    // si no se puede saber, como antes (opencode-local).
    const preset = core.slice(
      core.indexOf('function Get-ProviderPreset'),
      core.indexOf('function Start-OptionalOpenCode'),
    );
    expect(preset).toContain("Join-Path $PSScriptRoot 'resolve-preset.mjs'");
    expect(preset).toContain('Invoke-BoundedProgram $NodeExe');
    expect(preset).toContain("if(-not $v){return 'opencode-local'}");
    // Nunca se borra su contenedor.
    expect(core.replace(/^\s*#.*$/gm, '')).not.toContain('docker rm');
  });

  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { timeout: 20_000 }).status === 0;
  it.skipIf(!pwsh)(
    'las pruebas de PowerShell (canarios) pasan',
    () => {
      const r = spawnSync(
        'pwsh',
        ['-NoProfile', '-File', join(dir, 'test-autostart-canaries.ps1')],
        {
          encoding: 'utf8',
          timeout: 120_000,
        },
      );
      expect(r.stdout + r.stderr).toContain('autostart canaries OK');
      expect(r.status).toBe(0);
    },
    150_000,
  );

  it('resolve-preset.mjs da el preset con las reglas de Asistenta (sistema > archivo, última línea)', () => {
    const app = mkdtempSync(join(tmpdir(), 'pa-preset-'));
    const resolver = resolve(dir, 'resolve-preset.mjs');
    const run = (env: Record<string, string> = {}) => {
      const clean = { ...process.env };
      delete clean.PA_PROVIDER_PRESET;
      return spawnSync(process.execPath, [resolver], {
        cwd: app,
        env: { ...clean, ...env },
        encoding: 'utf8',
      }).stdout;
    };
    try {
      expect(run()).toBe('opencode');
      writeFileSync(
        join(app, '.env'),
        'PA_PROVIDER_PRESET=opencode-local\nPA_PROVIDER_PRESET= OpenCode \n',
      );
      expect(run()).toBe('opencode');
      writeFileSync(join(app, '.env'), 'PA_PROVIDER_PRESET=OpenCode-Local\n');
      expect(run()).toBe('opencode-local');
      expect(run({ PA_PROVIDER_PRESET: ' openrouter ' })).toBe('openrouter');
    } finally {
      rmSync(app, { recursive: true, force: true });
    }
  });

  it('pa doctor avisa de Docker encendido sin usarse, solo yendo por la nube', async () => {
    const text =
      'Docker/OpenCode local en marcha pero no se usa (vas por la nube): puedes cerrarlo';
    expect(unusedLocalLlmDoctorLine('opencode', true)).toContain(text);
    expect(unusedLocalLlmDoctorLine('openrouter', true)).toContain(text);
    expect(unusedLocalLlmDoctorLine(' OpenCode-Local ', true)).toBeNull();
    expect(unusedLocalLlmDoctorLine('opencode', false)).toBeNull();
    const calls: string[][] = [];
    const ps = (out: string | null) => async (exe: string, args: string[]) => {
      calls.push([exe, ...args]);
      return out;
    };
    expect(await localLlmContainerRunning(ps(`${LOCAL_LLM_CONTAINER}\n`))).toBe(true);
    expect(await localLlmContainerRunning(ps('otro\n'))).toBe(false);
    // Sin Docker (o sin permiso), no hay aviso.
    expect(await localLlmContainerRunning(ps(null))).toBe(false);
    // Solo lee: nunca start, stop ni rm.
    expect(calls.every((c) => c[0] === 'docker' && c[1] === 'ps')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SANDBOX_IMAGE,
  isDigestPinned,
  sandboxDoctorLines,
} from '../src/tools/shell-sandbox.js';

const up = async () => '27.3.1';
const down = async () => null;

describe('F12: imagen del sandbox fijada por digest', () => {
  it('la imagen por defecto va fijada por sha256 (no :latest)', () => {
    expect(isDigestPinned(DEFAULT_SANDBOX_IMAGE)).toBe(true);
    expect(DEFAULT_SANDBOX_IMAGE).not.toContain(':latest');
  });
  it('isDigestPinned distingue etiqueta de digest', () => {
    expect(isDigestPinned('mcr.microsoft.com/powershell:latest')).toBe(false);
    expect(isDigestPinned(`x@sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isDigestPinned(`x@sha256:${'a'.repeat(63)}`)).toBe(false);
  });
});

describe('pa doctor: líneas del sandbox de la shell', () => {
  it('apagado: lo dice y no exige docker', async () => {
    const l = await sandboxDoctorLines({}, down);
    expect(l[0]).toMatch(/^shell sandbox +off/);
    expect(l[1]).toMatch(/^docker +no disponible \(solo hace falta/);
    expect(l.some((x) => x.startsWith('sandbox image'))).toBe(false);
  });
  it('docker con docker vivo: versión e imagen fijada', async () => {
    const l = await sandboxDoctorLines({ PA_SHELL_SANDBOX: 'docker' }, up);
    expect(l[0]).toMatch(/^shell sandbox +docker/);
    expect(l[1]).toContain('ok (servidor 27.3.1)');
    expect(l[2]).toContain(DEFAULT_SANDBOX_IMAGE);
    expect(l[2]).toContain('(fijada por digest)');
  });
  it('docker sin docker: avisa de que se rechazarán los comandos', async () => {
    const l = await sandboxDoctorLines({ PA_SHELL_SANDBOX: 'docker' }, down);
    expect(l[1]).toContain('NO RESPONDE');
  });
  it('una imagen propia sin digest se señala', async () => {
    const l = await sandboxDoctorLines(
      { PA_SHELL_SANDBOX: 'docker', PA_SHELL_SANDBOX_IMAGE: 'mi/pwsh:latest' },
      up,
    );
    expect(l[2]).toContain('mi/pwsh:latest (SIN digest');
  });
  it('un modo inválido se marca como tal', async () => {
    const l = await sandboxDoctorLines({ PA_SHELL_SANDBOX: 'wsl' }, up);
    expect(l[0]).toMatch(/^shell sandbox +INVÁLIDO/);
  });
  it('una sonda que lanza cuenta como docker ausente', async () => {
    const l = await sandboxDoctorLines({ PA_SHELL_SANDBOX: 'docker' }, async () => {
      throw new Error('boom');
    });
    expect(l[1]).toContain('NO RESPONDE');
  });
});

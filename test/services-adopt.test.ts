import { describe, expect, it } from 'vitest';
import {
  buildCompose,
  costSmell,
  defaultUnverified,
  isValidPort,
  SERVE_CAVEATS,
  tailscaleServeArgs,
  tailscaleServeOffArgs,
  tailscaleStatusArgs,
  vetLicense,
} from '../src/services/adopt.js';

describe('vetLicense', () => {
  it('accepts the allowlist case-insensitively', () => {
    expect(vetLicense('MIT')).toBe('ok');
    expect(vetLicense('apache-2.0')).toBe('ok');
    expect(vetLicense('BSD-3-Clause')).toBe('ok');
  });
  it('flags unknown or missing as unknown, never as ok', () => {
    expect(vetLicense('')).toBe('unknown');
    expect(vetLicense('NOASSERTION')).toBe('unknown');
    expect(vetLicense('desconocida')).toBe('unknown');
  });
  it('refuses copyleft-strong or proprietary licenses', () => {
    expect(vetLicense('GPL-3.0')).toBe('refused');
    expect(vetLicense('SSPL-1.0')).toBe('refused');
    expect(vetLicense('propietaria')).toBe('refused');
  });
});

describe('costSmell', () => {
  it('catches money words in both languages', () => {
    expect(costSmell('tiene plan de pago y trial')).toBe(true);
    expect(costSmell('pricing page: subscription required')).toBe(true);
    expect(costSmell('pide tarjeta al registrarte')).toBe(true);
  });
  it('lets free software pass', () => {
    expect(costSmell('MIT, gratis, sin cuentas')).toBe(false);
    expect(costSmell('https://github.com/XMihura/Kanvas')).toBe(false);
  });
});

describe('buildCompose', () => {
  it('binds 127.0.0.1 only, never 0.0.0.0', () => {
    const yml = buildCompose({ name: 'kanvas', image: 'ghcr.io/x/kanvas:0.4.0rc4', port: 8071 });
    expect(yml).toContain('"127.0.0.1:8071:8071"');
    expect(yml).not.toContain('0.0.0.0');
    expect(yml).toContain('container_name: asistenta-svc-kanvas');
  });
  it('adds volume and env only when declared', () => {
    const plain = buildCompose({ name: 'a', image: 'img:1', port: 8080 });
    expect(plain).not.toContain('volumes:');
    const withData = buildCompose({
      name: 'a',
      image: 'img:1',
      port: 8080,
      dataDir: '/data',
      env: { FOO: 'bar' },
    });
    expect(withData).toContain('- ./data:/data');
    expect(withData).toContain('FOO: "bar"');
  });
});

describe('tailscale serve argv', () => {
  it('builds a tailnet-only serve; there is no funnel builder', () => {
    const args = tailscaleServeArgs(8071);
    expect(args).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:8071']);
    expect(args.join(' ')).not.toContain('funnel');
    expect(tailscaleServeOffArgs()).toEqual(['serve', '--https=443', 'off']);
    expect(tailscaleStatusArgs()).toEqual(['serve', 'status']);
  });
});

describe('isValidPort', () => {
  it('accepts unprivileged ports only', () => {
    expect(isValidPort(8071)).toBe(true);
    expect(isValidPort(80)).toBe(false);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(70000)).toBe(false);
    expect(isValidPort(8.5)).toBe(false);
  });
});

describe('defaultUnverified', () => {
  it('always carries the phone caveat when serving on the tailnet', () => {
    const u = defaultUnverified('docker', 'tailnet');
    for (const c of SERVE_CAVEATS) expect(u).toContain(c);
  });
  it('adds the local-method caveat', () => {
    expect(defaultUnverified('local', 'ninguna').some((l) => l.includes('instalación local'))).toBe(
      true,
    );
  });
});

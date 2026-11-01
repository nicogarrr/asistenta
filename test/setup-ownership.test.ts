import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it as baseIt, beforeEach, expect, vi } from 'vitest';
import { openDaemonControl } from '../src/daemon-control.js';
import { acquireSetupOwnership, inspectSetupOwnership } from '../src/setup-ownership.js';

const it = process.platform === 'linux' ? baseIt : baseIt.skip;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-setup-owner-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
it('initial read-only check creates nothing, including for a missing state', () => {
  inspectSetupOwnership(dir);
  expect(readdirSync(dir)).toEqual([]);
  const missing = join(dir, 'new');
  inspectSetupOwnership(missing);
  expect(existsSync(missing)).toBe(false);
});
it.each(['agent.pid', 'agent.pid.stale'])(
  'refuses legacy %s without probing or cleaning it',
  (name) => {
    const file = join(dir, name);
    writeFileSync(file, 'not-a-PID');
    const kill = vi.spyOn(process, 'kill');
    try {
      expect(() => acquireSetupOwnership(dir)).toThrow('ya se ha ejecutado aquí');
      expect(kill).not.toHaveBeenCalled();
      expect(readFileSync(file, 'utf8')).toBe('not-a-PID');
      expect(readdirSync(dir)).toEqual([name]);
    } finally {
      kill.mockRestore();
    }
  },
);
it.each(['ready.json', 'corrupt.tmp', 'unknown.sock'])(
  'refuses metadata %s without reading/reclaiming it',
  (name) => {
    const control = join(dir, 'control');
    mkdirSync(control, { mode: 0o700 });
    const file = join(control, name);
    writeFileSync(file, 'corrupt-synthetic', { mode: 0o600 });
    expect(() => acquireSetupOwnership(dir)).toThrow('restos de una ejecución anterior');
    expect(readFileSync(file, 'utf8')).toBe('corrupt-synthetic');
    expect(readdirSync(control)).toEqual([name]);
  },
);
it('wizard wins ownership and blocks both daemon start and another wizard, without publishing control', async () => {
  const owner = acquireSetupOwnership(dir);
  try {
    expect(() => acquireSetupOwnership(dir)).toThrow('ya está en marcha');
    await expect(openDaemonControl(dir, () => {})).rejects.toThrow('ocupado');
    expect(readdirSync(join(dir, 'control'))).toEqual(['owner.lock']);
    owner.assert();
  } finally {
    owner.release();
  }
  const daemon = await openDaemonControl(dir, () => {});
  await daemon.close();
});
it('daemon wins ownership and wizard cannot clean any metadata while it is alive', async () => {
  const daemon = await openDaemonControl(dir, () => {});
  daemon.ready();
  const before = readdirSync(join(dir, 'control')).sort();
  try {
    expect(() => acquireSetupOwnership(dir)).toThrow();
    expect(readdirSync(join(dir, 'control')).sort()).toEqual(before);
  } finally {
    await daemon.close();
  }
});
it('revalidates legacy markers created during the wizard without removing them', () => {
  const owner = acquireSetupOwnership(dir);
  try {
    writeFileSync(join(dir, 'agent.pid'), 'synthetic');
    expect(() => owner.assert()).toThrow('ya se ha ejecutado aquí');
    expect(readFileSync(join(dir, 'agent.pid'), 'utf8')).toBe('synthetic');
  } finally {
    owner.release();
  }
});
it('rejects preexisting open state without silently chmodding', () => {
  chmodSync(dir, 0o755);
  expect(() => acquireSetupOwnership(dir)).toThrow('permisos');
  expect(readdirSync(dir)).toEqual([]);
});
it('release is idempotent and never deletes or publishes metadata', () => {
  const owner = acquireSetupOwnership(dir);
  owner.release();
  owner.release();
  expect(() => owner.assert()).toThrow('ya había terminado');
  expect(readdirSync(join(dir, 'control'))).toEqual(['owner.lock']);
});

import {
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daemonStatus, statusCommand } from '../src/daemon-status.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-status-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const now = 1_800_000_000_000;

describe('pa status is evidence only', () => {
  it('does not create a missing state directory', () => {
    const stateDir = join(dir, 'missing');
    expect(daemonStatus({ stateDir }).pidState).toBe('missing');
    expect(existsSync(stateDir)).toBe(false);
  });
  it.each(['0', '-1', '1e3', '2.5', '123foo', '9007199254740993', ''])(
    'does not probe invalid PID %s',
    (raw) => {
      writeFileSync(join(dir, 'agent.pid'), raw);
      const before = readFileSync(join(dir, 'agent.pid'));
      const r = daemonStatus({
        stateDir: dir,
        probe: () => {
          throw new Error('must not probe');
        },
      });
      expect(r.pidState).toBe('invalid');
      expect(r.pid).toBe(null);
      expect(readFileSync(join(dir, 'agent.pid'))).toEqual(before);
    },
  );
  it.each(['alive', 'dead', 'unknown'] as const)(
    'reports %s without claiming app health',
    (value) => {
      writeFileSync(join(dir, 'agent.pid'), '123');
      writeFileSync(join(dir, 'agent.heartbeat'), String(now - 1000));
      const r = daemonStatus({ stateDir: dir, now: () => now, probe: () => value });
      expect(r.processState).toBe(value);
      expect(r.heartbeatState).toBe('fresh');
      expect(r.supervisionInstalled).toBe(null);
      expect(readdirSync(dir).sort()).toEqual(['agent.heartbeat', 'agent.pid']);
    },
  );
  it.each([
    [120_000, 'stale'],
    [119_999, 'fresh'],
    [-1, 'future'],
  ] as const)('classifies heartbeat age %s', (age, state) => {
    writeFileSync(join(dir, 'agent.heartbeat'), String(now - age));
    expect(daemonStatus({ stateDir: dir, now: () => now }).heartbeatState).toBe(state);
  });
  it('keeps probe failures unknown', () => {
    writeFileSync(join(dir, 'agent.pid'), '123');
    expect(
      daemonStatus({
        stateDir: dir,
        probe: () => {
          throw new Error('permission');
        },
      }).processState,
    ).toBe('unknown');
  });
  it('prints JSON and rejects options before accessing state', () => {
    let out = '';
    let err = '';
    expect(
      statusCommand(['--json'], { stateDir: dir }, (s) => {
        out += s;
      }),
    ).toBe(0);
    expect(JSON.parse(out).pidState).toBe('missing');
    expect(
      statusCommand(
        ['--restart'],
        {},
        () => {
          throw new Error('must not write');
        },
        (s) => {
          err += s;
        },
      ),
    ).toBe(2);
    expect(err).toContain('uso: pa status');
    expect(readdirSync(dir)).toEqual([]);
  });
  it('prints Spanish limits, not a running-supervisor claim', () => {
    let out = '';
    statusCommand([], { stateDir: dir }, (s) => {
      out += s;
    });
    expect(out).toContain('no inicia ni reinicia');
    expect(out).toContain('no comprueba si hay supervisor instalado');
  });
});

it.each(['not-a-timestamp', '', 'NaN', 'Infinity', '1e12', '-1'])(
  'never confirms invalid heartbeat content %s from mtime',
  (raw) => {
    writeFileSync(join(dir, 'agent.heartbeat'), raw);
    const report = daemonStatus({ stateDir: dir });
    expect(report.heartbeatSource).toBe('mtime');
    expect(report.heartbeatState).toBe('unverified');
    expect(report.ageMs).toBe(null);
    expect(report.modifiedAt).not.toBe(null);
    let out = '';
    statusCommand([], { stateDir: dir }, (s) => {
      out += s;
    });
    expect(out).toContain('contenido no es verificable');
    expect(out).not.toContain('Latido reciente:');
  },
);

it('rejects a directory as heartbeat instead of using its fresh mtime', () => {
  mkdirSync(join(dir, 'agent.heartbeat'));
  const report = daemonStatus({ stateDir: dir });
  expect(report.heartbeatSource).toBe('invalid');
  expect(report.heartbeatState).toBe('invalid');
  expect(report.ageMs).toBe(null);
  let out = '';
  statusCommand([], { stateDir: dir }, (s) => {
    out += s;
  });
  expect(out).toContain('inválido o ilegible');
  expect(out).not.toContain('Latido reciente:');
});

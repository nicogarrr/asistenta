import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonRunState } from '../src/autoupdate-cli.js';
import { processIdentity } from '../src/process-identity.js';

const dirs: string[] = [];
function stateDir(start?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-runstate-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'agent.pid'), '4242\n');
  if (start !== undefined) writeFileSync(join(dir, 'agent.pid.start'), start);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const alive = () => 'alive' as const;

describe('daemonRunState: pid reutilizado tras un cuelgue', () => {
  it('el pid vive pero es otro programa (identidad distinta): parada, el vigilante la relanza', () => {
    const dir = stateDir('4242 proc:111\n');
    expect(daemonRunState(dir, { probe: alive, identityOf: () => 'proc:999' })).toBe('stopped');
  });

  it.skipIf(process.platform !== 'linux')(
    'con el pid de un proceso vivo de verdad y un registro de arranque que no es el suyo: parada',
    () => {
      const dir = stateDir();
      writeFileSync(join(dir, 'agent.pid'), `${process.pid}\n`);
      writeFileSync(join(dir, 'agent.pid.start'), `${process.pid} proc:1\n`);
      // proc:1 nunca es el arranque real de este proceso de pruebas.
      expect(processIdentity(process.pid)).toMatch(/^proc:/);
      expect(daemonRunState(dir)).toBe('stopped');
    },
  );

  it('el mismo proceso que arrancó Asistenta: en marcha', () => {
    const dir = stateDir('4242 proc:111\n');
    expect(daemonRunState(dir, { probe: alive, identityOf: () => 'proc:111' })).toBe('running');
  });

  it('sin registro de arranque o identidad ilegible: sigue contando como en marcha', () => {
    expect(daemonRunState(stateDir(), { probe: alive, identityOf: () => 'proc:999' })).toBe(
      'running',
    );
    const dir = stateDir('4242 proc:111\n');
    expect(daemonRunState(dir, { probe: alive, identityOf: () => null })).toBe('running');
  });

  it('proceso muerto: parada, como antes', () => {
    expect(daemonRunState(stateDir('4242 proc:111\n'), { probe: () => 'dead' })).toBe('stopped');
  });
});

// Revisión de #1873/#1874 (migración del .env a OpenCode Go).
// 1) Si solo se cambiaba PA_MODEL=…-free no quedaba la marca de «ya migrado», así
//    que un -free elegido a propósito después se volvía a pisar en cada arranque.
// 2) Un .env de Windows va en CRLF: la migración dejaba líneas con LF suelto en medio;
//    ahora conserva los CRLF.
import { describe, expect, it } from 'vitest';
import { migrateLocalPresetPin, PRESET_MIGRATION_MARKER } from '../src/preset-migration.js';

function fs(text: string) {
  const writes: Record<string, string> = {};
  return {
    writes,
    deps: {
      files: ['/x/.env'],
      readFile: (p: string) => {
        const t = writes[p] ?? (p === '/x/.env' ? text : undefined);
        if (t === undefined) throw new Error('no existe');
        return Buffer.from(t, 'utf8');
      },
      writeFile: (p: string, t: string) => {
        writes[p] = t;
      },
    },
  };
}

describe('migración del .env: CRLF y marca', () => {
  it('un .env CRLF con el pin local se migra y conserva los CRLF y la clave', () => {
    const { writes, deps } = fs(
      'OPENCODE_GO_API_KEY=sk-abc\r\nPA_PROVIDER_PRESET=opencode-local\r\nPA_MODEL=deepseek-v4.1-flash-free\r\nOTRA=1\r\n',
    );
    const env: { PA_PROVIDER_PRESET?: string; PA_MODEL?: string } = {
      PA_PROVIDER_PRESET: 'opencode-local',
      PA_MODEL: 'deepseek-v4.1-flash-free',
    };
    expect(migrateLocalPresetPin({ ...deps, env })).toContain('OpenCode Go');
    const out = writes['/x/.env'] ?? '';
    expect(out).toContain('OPENCODE_GO_API_KEY=sk-abc\r\n');
    expect(out).toContain('PA_PROVIDER_PRESET=opencode\r\n');
    expect(out).toContain('PA_MODEL=deepseek-v4.1-flash\r\n');
    expect(out).toContain(PRESET_MIGRATION_MARKER);
    expect(out).toContain('OTRA=1\r\n');
    expect(out).not.toMatch(/[^\r]\n/);
    expect(env).toEqual({ PA_PROVIDER_PRESET: 'opencode', PA_MODEL: 'deepseek-v4.1-flash' });
  });

  it('solo PA_MODEL=-free: deja la marca y no vuelve a pisar un -free puesto después', () => {
    const { writes, deps } = fs('PA_MODEL=deepseek-v4.1-flash-free\n');
    const env: { PA_MODEL?: string } = { PA_MODEL: 'deepseek-v4.1-flash-free' };
    expect(migrateLocalPresetPin({ ...deps, env })).not.toBeNull();
    const out = writes['/x/.env'] ?? '';
    expect(out).toContain('PA_MODEL=deepseek-v4.1-flash\n');
    expect(out).toContain(PRESET_MIGRATION_MARKER);
    // Nico vuelve a poner el -free a propósito: segundo arranque, no se toca.
    writes['/x/.env'] = out.replace(
      'PA_MODEL=deepseek-v4.1-flash\n',
      'PA_MODEL=deepseek-v4.1-flash-free\n',
    );
    const env2: { PA_MODEL?: string } = { PA_MODEL: 'deepseek-v4.1-flash-free' };
    expect(migrateLocalPresetPin({ ...deps, env: env2 })).toBeNull();
    expect(writes['/x/.env']).toContain('PA_MODEL=deepseek-v4.1-flash-free\n');
    expect(env2.PA_MODEL).toBe('deepseek-v4.1-flash-free');
  });
});

// Migración única del pin opencode-local del .env (decisión de Nico,
// 2-nov-2026: DeepSeek V4.1 Flash por OpenCode Go, no el serve local).
import { describe, expect, it } from 'vitest';
import { migrateLocalPresetPin, PRESET_MIGRATION_MARKER } from '../src/preset-migration.js';

function fakeFs(files: Record<string, string | Buffer>) {
  const writes: Record<string, string> = {};
  return {
    writes,
    deps: {
      files: Object.keys(files),
      readFile: (p: string) => {
        const v = files[p];
        if (v === undefined) throw new Error('no existe');
        return Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8');
      },
      writeFile: (p: string, text: string) => {
        writes[p] = text;
      },
    },
  };
}

describe('migración del pin opencode-local', () => {
  it('reescribe el pin del .env a opencode, deja marca y ajusta process.env', () => {
    const { writes, deps } = fakeFs({
      '/x/.env': 'PA_PROVIDER_PRESET=opencode-local\nOTRA=1\n',
    });
    const env = { PA_PROVIDER_PRESET: 'opencode-local' as string | undefined };
    const note = migrateLocalPresetPin({ ...deps, env });
    expect(note).toContain('OpenCode Go');
    expect(writes['/x/.env']).toContain('PA_PROVIDER_PRESET=opencode');
    expect(writes['/x/.env']).toContain(PRESET_MIGRATION_MARKER);
    expect(writes['/x/.env']).toContain('OTRA=1');
    expect(env.PA_PROVIDER_PRESET).toBe('opencode');
  });

  it('con los dos pins (preset local + modelo -free) migra ambos', () => {
    const { writes, deps } = fakeFs({
      '/x/.env': 'PA_PROVIDER_PRESET=opencode-local\nPA_MODEL=deepseek-v4.1-flash-free\n',
    });
    const env = {
      PA_PROVIDER_PRESET: 'opencode-local' as string | undefined,
      PA_MODEL: 'deepseek-v4.1-flash-free' as string | undefined,
    };
    expect(migrateLocalPresetPin({ ...deps, env })).toContain('OpenCode Go');
    expect(writes['/x/.env']).toContain('PA_PROVIDER_PRESET=opencode');
    expect(writes['/x/.env']).toContain('PA_MODEL=deepseek-v4.1-flash');
    expect(writes['/x/.env']).not.toContain('-free');
    expect(env.PA_PROVIDER_PRESET).toBe('opencode');
    expect(env.PA_MODEL).toBe('deepseek-v4.1-flash');
  });

  it('solo PA_MODEL=-free: corrige el modelo sin inventar preset', () => {
    const { writes, deps } = fakeFs({ '/x/.env': 'PA_MODEL=deepseek-v4.1-flash-free\n' });
    const env = { PA_MODEL: 'deepseek-v4.1-flash-free' as string | undefined };
    expect(migrateLocalPresetPin({ ...deps, env })).not.toBeNull();
    expect(writes['/x/.env']).toContain('PA_MODEL=deepseek-v4.1-flash');
    expect(writes['/x/.env']).not.toContain('PA_PROVIDER_PRESET=opencode');
    expect(env.PA_MODEL).toBe('deepseek-v4.1-flash');
  });

  it('PA_MODEL con otro valor se respeta aunque migre el preset', () => {
    const { writes, deps } = fakeFs({
      '/x/.env': 'PA_PROVIDER_PRESET=opencode-local\nPA_MODEL=otro-modelo\n',
    });
    const env = { PA_MODEL: 'otro-modelo' as string | undefined };
    expect(migrateLocalPresetPin({ ...deps, env })).not.toBeNull();
    expect(writes['/x/.env']).toContain('PA_MODEL=otro-modelo');
    expect(env.PA_MODEL).toBe('otro-modelo');
  });

  it('con la marca presente no toca nada (re-pin deliberado)', () => {
    const { writes, deps } = fakeFs({
      '/x/.env': `PA_PROVIDER_PRESET=opencode-local\n${PRESET_MIGRATION_MARKER}\n`,
    });
    const env = { PA_PROVIDER_PRESET: 'opencode-local' as string | undefined };
    expect(migrateLocalPresetPin({ ...deps, env })).toBeNull();
    expect(Object.keys(writes)).toHaveLength(0);
    expect(env.PA_PROVIDER_PRESET).toBe('opencode-local');
  });

  it('sin pin local no toca nada', () => {
    const { writes, deps } = fakeFs({ '/x/.env': 'PA_PROVIDER_PRESET=openrouter\n' });
    expect(migrateLocalPresetPin({ ...deps, env: {} })).toBeNull();
    expect(Object.keys(writes)).toHaveLength(0);
  });

  it('ignora el pin comentado', () => {
    const { writes, deps } = fakeFs({ '/x/.env': '# PA_PROVIDER_PRESET=opencode-local\n' });
    expect(migrateLocalPresetPin({ ...deps, env: {} })).toBeNull();
    expect(Object.keys(writes)).toHaveLength(0);
  });

  it('si el pin no está en el archivo no toca el entorno (variable real manda)', () => {
    const { writes, deps } = fakeFs({ '/x/.env': 'OTRA=1\n' });
    const env = { PA_PROVIDER_PRESET: 'opencode-local' as string | undefined };
    expect(migrateLocalPresetPin({ ...deps, env })).toBeNull();
    expect(Object.keys(writes)).toHaveLength(0);
    expect(env.PA_PROVIDER_PRESET).toBe('opencode-local');
  });

  it('lee .env en UTF-16 (como los guarda Windows) y reescribe en UTF-8', () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('PA_PROVIDER_PRESET=opencode-local\n', 'utf16le'),
    ]);
    const { writes, deps } = fakeFs({ '/x/.env': utf16 });
    const env = { PA_PROVIDER_PRESET: 'opencode-local' as string | undefined };
    expect(migrateLocalPresetPin({ ...deps, env })).not.toBeNull();
    expect(writes['/x/.env']).toContain('PA_PROVIDER_PRESET=opencode');
  });

  it('si no puede escribir avisa y no toca el entorno', () => {
    const env = { PA_PROVIDER_PRESET: 'opencode-local' as string | undefined };
    const note = migrateLocalPresetPin({
      files: ['/x/.env'],
      readFile: () => Buffer.from('PA_PROVIDER_PRESET=opencode-local\n'),
      writeFile: () => {
        throw new Error('solo lectura');
      },
      env,
    });
    expect(note).toContain('Aviso');
    expect(env.PA_PROVIDER_PRESET).toBe('opencode-local');
  });

  it('sin .env legible no hace nada', () => {
    const env = {} as { PA_PROVIDER_PRESET?: string };
    expect(
      migrateLocalPresetPin({
        files: ['/x/.env'],
        readFile: () => {
          throw new Error('no existe');
        },
        writeFile: () => {},
        env,
      }),
    ).toBeNull();
  });
});

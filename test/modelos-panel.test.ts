// Selector de modelo de la tarjeta Estado: solo opciones de coste cero
// verificadas (medición 2-nov-2026: cost 0 + tool-calling en cada una).
import { describe, expect, it } from 'vitest';
import { aplicarModeloPanel, MODELOS_PANEL, upsertEnvLines } from '../src/modelos-panel.js';

describe('upsertEnvLines', () => {
  it('sustituye la línea activa existente', () => {
    const out = upsertEnvLines('PA_MODEL=deepseek-v4.1-flash-free\nOTRA=1\n', {
      PA_MODEL: 'deepseek-v4.1-flash',
    });
    expect(out).toBe('PA_MODEL=deepseek-v4.1-flash\nOTRA=1\n');
  });

  it('añade la línea si falta y respeta las comentadas', () => {
    const out = upsertEnvLines('# PA_MODEL=viejo\nOTRA=1', { PA_MODEL: 'nuevo' });
    expect(out).toBe('# PA_MODEL=viejo\nOTRA=1\nPA_MODEL=nuevo\n');
  });

  it('escribe varias claves de una vez', () => {
    const out = upsertEnvLines('', { PA_PROVIDER_PRESET: 'opencode', PA_MODEL: 'glm-5.3' });
    expect(out).toBe('PA_PROVIDER_PRESET=opencode\nPA_MODEL=glm-5.3\n');
  });
});

function fakeFs(files: Record<string, string>) {
  const writes: Record<string, string> = {};
  return {
    writes,
    deps: {
      files: Object.keys(files),
      readFile: (p: string) => {
        const v = files[p];
        if (v === undefined) throw new Error('no existe');
        return Buffer.from(v, 'utf8');
      },
      writeFile: (p: string, text: string) => {
        writes[p] = text;
      },
    },
  };
}

describe('aplicarModeloPanel', () => {
  it('rechaza un modelo fuera de la lista verificada', () => {
    const r = aplicarModeloPanel('gpt-carísimo', { files: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toContain('coste cero');
  });

  it('fija preset+modelo en el .env, en el entorno y en la config viva', () => {
    const { writes, deps } = fakeFs({
      '/x/.env': 'PA_PROVIDER_PRESET=opencode-local\nPA_MODEL=deepseek-v4.1-flash-free\n',
    });
    const env = {
      PA_PROVIDER_PRESET: 'opencode-local' as string | undefined,
      PA_MODEL: 'deepseek-v4.1-flash-free' as string | undefined,
    };
    const vivo: Record<string, unknown> = { model: 'deepseek-v4.1-flash-free' };
    const r = aplicarModeloPanel('glm-5.3', {
      ...deps,
      env,
      reloadConfig: () => ({ model: 'glm-5.3', provider: 'opencode-go' }),
      applyConfig: (fresh) => Object.assign(vivo, fresh),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mensaje).toContain('GLM 5.3');
      expect(r.mensaje).toContain('coste 0');
    }
    expect(writes['/x/.env']).toContain('PA_PROVIDER_PRESET=opencode');
    expect(writes['/x/.env']).toContain('PA_MODEL=glm-5.3');
    expect(writes['/x/.env']).not.toContain('opencode-local');
    expect(env.PA_PROVIDER_PRESET).toBe('opencode');
    expect(env.PA_MODEL).toBe('glm-5.3');
    expect(vivo.model).toBe('glm-5.3');
    expect(vivo.provider).toBe('opencode-go');
  });

  it('sin .env existente lo crea en la primera ruta', () => {
    const writes: Record<string, string> = {};
    const r = aplicarModeloPanel('deepseek-v4.1-flash', {
      files: ['/x/.env'],
      readFile: () => {
        throw new Error('no existe');
      },
      writeFile: (p, t) => {
        writes[p] = t;
      },
      env: {},
    });
    expect(r.ok).toBe(true);
    expect(writes['/x/.env']).toContain('PA_MODEL=deepseek-v4.1-flash');
  });

  it('si no puede escribir avisa con las líneas a poner a mano', () => {
    const r = aplicarModeloPanel('glm-5.3', {
      files: ['/x/.env'],
      readFile: () => Buffer.from(''),
      writeFile: () => {
        throw new Error('solo lectura');
      },
      env: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toContain('PA_MODEL=glm-5.3');
  });

  it('la lista ofrecida son solo las medidas a coste 0 con herramientas', () => {
    expect(MODELOS_PANEL.map((m) => m.id)).toEqual([
      'hy4-flash-free',
      'deepseek-v4.1-flash',
      'deepseek-v4-pro',
      'glm-5.3-flash',
      'glm-5.3',
      'qwen3.8-flash',
      'minimax-m3.1-flash',
    ]);
  });
});

it('Hy4 announces the promotion and refuses permanent zero-cost claims', () => {
  const out = aplicarModeloPanel('hy4-flash-free', {
    files: [],
    readFile: () => {
      throw new Error('missing');
    },
    writeFile: () => {},
    env: {},
  });
  expect(out.ok).toBe(true);
  expect(out.mensaje).toContain('promoción temporal');
  expect(out.mensaje).toContain('se bloquea');
});

it('replaces active env lines but preserves commented keys', () => {
  expect(upsertEnvLines('# PA_MODEL=x\n', { PA_MODEL: 'hy4-flash-free' })).toContain(
    '# PA_MODEL=x\nPA_MODEL=hy4-flash-free',
  );
  expect(upsertEnvLines('', {})).toBe('');
});

it('falls back to process env and a default destination when dependencies omit them', () => {
  const previous = { ...process.env };
  try {
    const result = aplicarModeloPanel('hy4-flash-free', {
      files: [],
      readFile: () => Buffer.from(''),
      writeFile: () => {},
      reloadConfig: () => ({}),
    });
    expect(result.ok).toBe(true);
    expect(process.env.PA_MODEL).toBe('hy4-flash-free');
  } finally {
    process.env = previous;
  }
});

it('uses actual read/write defaults only on an isolated temporary env file', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'hy4-panel-'));
  const path = join(dir, '.env');
  try {
    writeFileSync(path, 'PA_MODEL=old\n');
    const result = aplicarModeloPanel('hy4-flash-free', { files: [path], env: {} });
    expect(result.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('PA_MODEL=hy4-flash-free');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

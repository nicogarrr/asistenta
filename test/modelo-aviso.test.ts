import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { modelSwitchWarnings } from '../src/model-choice.js';

const big = { contextWindow: 200_000, supportsImages: true };

describe('/modelo avisa al cambiar a un modelo más limitado', () => {
  it('ventana de la mitad o menos: avisa con los dos tamaños', () => {
    const w = modelSwitchWarnings(big, { contextWindow: 32_000, supportsImages: true });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('32k');
    expect(w[0]).toContain('200k');
  });

  it('sin imágenes cuando el anterior sí: avisa', () => {
    const w = modelSwitchWarnings(big, { contextWindow: 200_000, supportsImages: false });
    expect(w).toEqual([expect.stringContaining('no ve imágenes')]);
  });

  it('ambas cosas a la vez: dos avisos', () => {
    expect(modelSwitchWarnings(big, { contextWindow: 8_000, supportsImages: false })).toHaveLength(
      2,
    );
  });

  it('modelo igual o mejor, o algo menor pero más de la mitad: sin aviso', () => {
    expect(modelSwitchWarnings(big, big)).toEqual([]);
    expect(modelSwitchWarnings(big, { contextWindow: 128_000, supportsImages: true })).toEqual([]);
    expect(
      modelSwitchWarnings(
        { contextWindow: 32_000, supportsImages: false },
        { contextWindow: 200_000, supportsImages: true },
      ),
    ).toEqual([]);
  });

  it('ventana desconocida (0) no dispara aviso', () => {
    expect(modelSwitchWarnings(big, { contextWindow: 0, supportsImages: true })).toEqual([]);
  });

  it('el daemon añade los avisos a la respuesta de /modelo con la ficha de cada modelo', () => {
    const cli = readFileSync(join(import.meta.dirname, '../src/cli.ts'), 'utf8');
    expect(cli).toContain('const prevModel = thread.agent.modelId;');
    expect(cli).toContain('modeloWarningText(prevModel, r.model)');
    expect(cli).toContain('envOverrides: id === config.model');
  });
});

import { describe, expect, it } from 'vitest';
import { parseModelList } from '../src/config.js';
import { extraModelIds } from '../src/core/provider.js';
import { formatModelos } from '../src/model-choice.js';

describe('PA_MODELS: más modelos para /modelo', () => {
  it('parsea comas o espacios, sin vacíos ni repetidos, como mucho 8', () => {
    expect(parseModelList(undefined)).toEqual([]);
    expect(parseModelList(' a, b ,,a  c ')).toEqual(['a', 'b', 'c']);
    expect(parseModelList('1,2,3,4,5,6,7,8,9,10')).toHaveLength(8);
  });

  it('no repite PA_MODEL ni PA_FALLBACK_MODEL', () => {
    expect(
      extraModelIds({ model: 'p', fallbackModel: 'f', extraModels: ['f', 'x', 'p', 'y', 'x'] }),
    ).toEqual(['x', 'y']);
    expect(extraModelIds({ model: 'p' })).toEqual([]);
  });

  it('la ayuda de /modelo menciona PA_MODELS cuando solo hay uno', () => {
    expect(formatModelos(['p'], 'p')).toContain('PA_MODELS');
  });
});

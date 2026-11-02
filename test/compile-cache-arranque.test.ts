import { getCompileCacheDir } from 'node:module';
import { describe, expect, it } from 'vitest';

describe('caché de compilación del arranque', () => {
  it('importar la entrada (envfile, siempre el primero) activa la caché de V8', async () => {
    await import('../src/envfile.js');
    expect(getCompileCacheDir()).toBeTruthy();
  });
});

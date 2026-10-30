import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installLifecycle } from '../src/lifecycle.js';

// Fichero propio: los manejadores de señal de installLifecycle son globales.
afterEach(() => vi.restoreAllMocks());

describe('segundo Ctrl+C durante el cierre', () => {
  it('sale ya (130) en vez de esperar todo el presupuesto; el marcador .stale queda', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const dir = mkdtempSync(join(tmpdir(), 'pa-lc2-'));
    let finish!: () => void;
    const lc = installLifecycle({
      name: 'sig',
      stateDir: dir,
      shutdownBudgetMs: 60_000,
      onShutdown: () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    });
    process.emit('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'sig.pid.stale'))).toBe(true);
    process.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
    // Un SIGTERM repetido (gestor de servicios) no corta el drenaje.
    exit.mockClear();
    process.emit('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
    finish();
    await lc.done;
  });
});

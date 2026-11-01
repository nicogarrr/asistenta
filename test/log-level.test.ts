import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLogLevel } from '../src/log.js';

describe('PA_LOG_LEVEL', () => {
  it('acepta mayúsculas, espacios y «warning»', () => {
    expect(parseLogLevel('WARN')).toEqual({ level: 'warn' });
    expect(parseLogLevel(' Debug \r')).toEqual({ level: 'debug' });
    expect(parseLogLevel('ERROR')).toEqual({ level: 'error' });
    expect(parseLogLevel('warning')).toEqual({ level: 'warn' });
  });

  it('vacío o sin definir es info, sin aviso', () => {
    expect(parseLogLevel(undefined)).toEqual({ level: 'info' });
    expect(parseLogLevel('  ')).toEqual({ level: 'info' });
  });

  it('un valor desconocido usa info y lo señala', () => {
    expect(parseLogLevel('ruido')).toEqual({ level: 'info', invalid: 'ruido' });
    expect(parseLogLevel('toString')).toEqual({ level: 'info', invalid: 'toString' });
  });

  describe('al cargar el módulo', () => {
    const prev = process.env.PA_LOG_LEVEL;
    afterEach(() => {
      if (prev === undefined) delete process.env.PA_LOG_LEVEL;
      else process.env.PA_LOG_LEVEL = prev;
      vi.restoreAllMocks();
      vi.resetModules();
    });

    async function linesWith(level: string): Promise<{ out: string[]; err: string[] }> {
      process.env.PA_LOG_LEVEL = level;
      vi.resetModules();
      const out: string[] = [];
      const err: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
        out.push(String(c));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
        err.push(String(c));
        return true;
      });
      vi.doMock('node:fs', async (orig) => ({
        ...(await orig<typeof import('node:fs')>()),
        appendFileSync: () => undefined,
        mkdirSync: () => undefined,
      }));
      const { log } = await import('../src/log.js');
      log.info('ruido de arranque');
      log.warn('aviso de arranque');
      vi.doUnmock('node:fs');
      return { out, err };
    }

    it('«WARN» en el .env calla los info y deja los avisos', async () => {
      const { out } = await linesWith('WARN');
      expect(out.join('')).not.toContain('ruido de arranque');
      expect(out.join('')).toContain('aviso de arranque');
    });

    it('un valor desconocido avisa una vez por stderr y registra info', async () => {
      const { out, err } = await linesWith('verbose');
      expect(err.join('')).toContain('PA_LOG_LEVEL="verbose" no es válido');
      expect(out.join('')).toContain('ruido de arranque');
    });
  });
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ocrFailText, runOcrSidecar } from '../src/tools/ocr-local.js';

// robustez-10: el OCR local ya no pega en el chat la última línea del
// traceback de Python; da una causa en castellano y el detalle va al registro.
function failing(stderr: string, stdout = '') {
  return (_cmd: string, _args: string[]) => {
    const c = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    setImmediate(() => {
      c.stderr.write(stderr);
      c.stdout.end(stdout);
      c.emit('close', 1);
    });
    return c as never;
  };
}

const base = { python: 'py', script: 'ocr_sidecar.py', model: 'ppocr' as const, file: '/x/a.png' };

async function message(stderr: string, stdout = ''): Promise<string> {
  const err = await runOcrSidecar({ ...base, spawnFn: failing(stderr, stdout) }).catch(
    (e: Error) => e,
  );
  return err instanceof Error ? err.message : String(err);
}

describe('OCR local: fallos en castellano llano', () => {
  it('sin memoria', async () => {
    const m = await message('Traceback (most recent call last):\nMemoryError\n');
    expect(m).toContain('sin memoria');
    expect(m).not.toMatch(/Traceback|MemoryError/);
  });

  it('imagen dañada', async () => {
    const m = await message(
      "PIL.UnidentifiedImageError: cannot identify image file 'C:\\Users\\Nico\\a.png'\n",
    );
    expect(m).toContain('puede estar dañado');
    expect(m).not.toMatch(/PIL|Users|Nico/);
  });

  it('archivo bloqueado (Windows)', async () => {
    const m = await message("PermissionError: [Errno 13] Permission denied: 'C:\\x.pdf'\n");
    expect(m).toContain('Windows no me deja leer el archivo');
    expect(m).not.toMatch(/Errno|PermissionError/);
  });

  it('falta un módulo: da la pista de instalación', async () => {
    const m = await message("ModuleNotFoundError: No module named 'paddle'\n");
    expect(m).toContain('le falta una pieza');
    expect(m).not.toContain('ModuleNotFoundError');
  });

  it('el JSON de error del sidecar tampoco sale crudo', async () => {
    const m = await message(
      '',
      `${JSON.stringify({ ok: false, error: 'boom', detail: 'ValueError: bad shape (3, 0)' })}\n`,
    );
    expect(m).toContain('algo ha fallado por mi parte');
    expect(m).not.toMatch(/ValueError|shape/);
  });

  it('ocrFailText: lo desconocido no se pega tal cual', () => {
    const t = ocrFailText('RuntimeError: CUDA error: device-side assert triggered', 'ppocr');
    expect(t).not.toContain('CUDA');
    expect(ocrFailText('std::bad_alloc', 'glm')).toContain('sin memoria');
  });
});

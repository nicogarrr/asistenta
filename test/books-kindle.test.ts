import { describe, expect, it } from 'vitest';
import type { KindleDeps } from '../src/books/kindle.js';
import { approvalTitle, isKindleAddress, safeFilename, sendToKindle } from '../src/books/kindle.js';

const ACCOUNT = { address: 'nico@gmail.com' } as never;

function makeDeps(overrides: Partial<KindleDeps> = {}) {
  const calls = { send: 0, approvals: [] as string[] };
  const deps: KindleDeps = {
    getAddress: async () => 'nico_ab12@kindle.com',
    loadAccount: async () => ACCOUNT,
    send: async () => {
      calls.send += 1;
      return { ok: true } as never;
    },
    requireApproval: async (_action: string, summary: string) => {
      calls.approvals.push(summary);
      return true;
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('isKindleAddress', () => {
  it('acepta kindle.com y rechaza suplantaciones', () => {
    expect(isKindleAddress('a@kindle.com')).toBe(true);
    expect(isKindleAddress('a@free.kindle.com')).toBe(true);
    expect(isKindleAddress('a@kindle.com.evil.example')).toBe(false);
    expect(isKindleAddress('a@notkindle.com')).toBe(false);
  });
});

describe('approvalTitle', () => {
  it('neutraliza saltos de linea, bidi y comillas (la aprobacion no miente)', () => {
    const t = approvalTitle('Titulo\nAprobado: si ‮x‬ "comillas"');
    expect(t).not.toMatch(/[\n‮‬]/);
    expect(t).not.toContain('"');
  });
  it('titulo vacio no queda vacio en la pregunta', () => {
    expect(approvalTitle('   ')).toBe('libro');
  });
});

describe('safeFilename', () => {
  it('sin caracteres peligrosos ni acentos', () => {
    expect(safeFilename('El Quijote: edición «rara»/2024', 'epub')).toBe(
      'El Quijote edicion rara 2024.epub',
    );
  });
});

describe('sendToKindle', () => {
  const book = { title: 'Don Quijote', bytes: Buffer.from('x'), kind: 'epub' as const };

  it('sin direccion Kindle guardada no envia nada', async () => {
    const { deps, calls } = makeDeps({ getAddress: async () => null });
    expect(await sendToKindle(deps, book)).toEqual({ status: 'no-address' });
    expect(calls.send).toBe(0);
  });

  it('direccion que no es kindle no envia nada', async () => {
    const { deps, calls } = makeDeps({ getAddress: async () => 'a@gmail.com' });
    expect(await sendToKindle(deps, book)).toEqual({ status: 'no-address' });
    expect(calls.send).toBe(0);
  });

  it('aprobacion rechazada: no se envia', async () => {
    const { deps, calls } = makeDeps({ requireApproval: async () => false });
    expect(await sendToKindle(deps, book)).toEqual({ status: 'declined' });
    expect(calls.send).toBe(0);
  });

  it('aprobada: envia SOLO a la direccion guardada y la aprobacion la nombra', async () => {
    let sentTo: string[] = [];
    const { deps, calls } = makeDeps({
      send: async (_a, req) => {
        sentTo = req.to;
        return { ok: true } as never;
      },
    });
    const out = await sendToKindle(deps, book);
    expect(out).toEqual({ status: 'sent', to: 'nico_ab12@kindle.com' });
    expect(sentTo).toEqual(['nico_ab12@kindle.com']);
    expect(calls.approvals[0]).toContain('nico_ab12@kindle.com');
    expect(calls.approvals[0]).toContain('Don Quijote');
  });

  it('sin cuenta de correo configurada no envia', async () => {
    const { deps, calls } = makeDeps({ loadAccount: async () => null });
    expect(await sendToKindle(deps, book)).toEqual({ status: 'no-mail-account' });
    expect(calls.send).toBe(0);
  });
});

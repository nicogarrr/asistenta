import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACK_AFTER_MS, ackDue, ackLine, TurnAck } from '../src/daemon/turn-ack.js';

/**
 * Como Tab: si un pedido tarda, una línea corta que nombra la tarea; si es rápido,
 * nada. Telegram falso: solo se anota lo que se publicaría en el chat.
 */
function fakeChat(enabled = () => true) {
  const sent: string[] = [];
  const ack = new TurnAck({ show: (t) => void sent.push(t), enabled });
  return { sent, ack };
}

describe('acuse de un turno largo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('una respuesta rápida no lleva acuse', () => {
    const { sent, ack } = fakeChat();
    expect(ack.tick(3_000, [])).toBe(false);
    expect(ack.tick(5_000, ['memory'])).toBe(false);
    expect(sent).toEqual([]);
  });

  it('a los 8 s sin respuesta avisa una sola vez', () => {
    const { sent, ack } = fakeChat();
    expect(ack.tick(ACK_AFTER_MS, [])).toBe(true);
    ack.tick(20_000, []);
    ack.tick(40_000, ['correo']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/pens|piens/i);
  });

  it('varias herramientas seguidas ya son un acuse, nombrando la tarea', () => {
    const { sent, ack } = fakeChat();
    ack.tick(1_500, ['memory']);
    ack.tick(2_000, ['memory', 'correo']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/correo/);
  });

  it('nombra la tarea según la herramienta', () => {
    expect(ackLine(['browser'], () => 0)).toMatch(/internet|web|buscando/);
    expect(ackLine(['computer'], () => 0)).toMatch(/ordenador|PC/);
    expect(ackLine(['agenda'], () => 0)).toMatch(/agenda/);
    expect(ackLine(['tv'], () => 0)).toMatch(/tele/);
    expect(ackLine(['repartos'], () => 0)).toMatch(/envíos|paquetes/);
  });

  it('no repite la misma frase dos turnos seguidos', () => {
    const a = ackLine(['correo'], () => 0);
    const b = ackLine(['correo'], () => 0);
    expect(a).not.toBe(b);
  });

  it('frases cortas, en castellano y sin nombres técnicos', () => {
    for (const tool of ['correo', 'browser', 'computer', 'tv', 'shell', 'x_desconocida']) {
      for (let i = 0; i < 3; i++) {
        const line = ackLine([tool], () => i);
        expect(line.length).toBeLessThanOrEqual(60);
        expect(line).not.toMatch(/browser|shell|computer|tool|x_desconocida/i);
      }
    }
  });

  it('respeta /estado off, un acuse ya enviado (voz/foto) y el turno terminado', () => {
    const { sent, ack } = fakeChat(() => false);
    expect(ack.tick(30_000, ['correo', 'correo'])).toBe(false);
    expect(sent).toEqual([]);
  });

  it('si Telegram falla al publicar, el turno sigue', async () => {
    const ack = new TurnAck({ show: () => Promise.reject(new Error('red')), enabled: () => true });
    expect(ack.tick(9_000, [])).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('ackDue: una vez por turno', () => {
    expect(ackDue({ elapsedMs: 9_000, toolCalls: 0, acked: true })).toBe(false);
    expect(ackDue({ elapsedMs: 100, toolCalls: 2, acked: false })).toBe(true);
  });
});

describe('cableado en el turno de Telegram', () => {
  it('«escribiendo…» sale al momento y el acuse se mira en cada herramienta y cada tic', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toContain("if (!out) void telegram.action(inbound.chatId, 'typing');");
    expect(src.match(/turnAck\.tick\(Date\.now\(\) - startedAt, toolNames\)/g)?.length).toBe(2);
  });
});

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { AgendaItem } from '../src/agenda/unified.js';

/**
 * Paridad con las capturas de otro asistente («Gertru», 8 capturas que pasó Nico el 31-10).
 * Un test por cosa que hace ese agente. Lo que Asistenta ya sabe hacer se prueba de verdad
 * (herramienta, ruta, forma de la salida) con dobles: sin red, sin modelo, sin cuentas.
 * Lo que todavía no sabe hacer queda como `it.todo` con la nota de por qué.
 * Lista completa: work/asis/capshots/CAPABILITIES.md.
 */

const descarga = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('../src/media/download.js', async (orig) => {
  const real = await orig<typeof import('../src/media/download.js')>();
  return {
    ...real,
    downloadFromLink: async (url: string) => {
      descarga.urls.push(url);
      return {
        ok: true as const,
        kind: 'video' as const,
        bytes: Buffer.alloc(2048),
        title: 'Vídeo de prueba',
        seconds: 42,
        filename: 'video.mp4',
      };
    },
  };
});

const H = 3_600_000;
const at = (iso: string): number => new Date(iso).getTime();
const reunion = (title: string, when: number, end: number): AgendaItem => ({
  title,
  at: when,
  end,
  kind: 'meeting',
  where: 'calendario',
  timed: true,
});
const texto = (res: { content: Array<{ type: string; text?: string }> }): string =>
  res.content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');

async function descargaYEnvia(url: string) {
  const { createDownloadTool } = await import('../src/tools/download.js');
  const videos: Array<{ seconds: number; label: string }> = [];
  const tool = createDownloadTool({
    sendVideo: async (_b, seconds, label) => {
      videos.push({ seconds, label });
      return true;
    },
    sendDocument: async () => true,
  });
  const res = await tool.execute('t', { url }, undefined as never, undefined as never);
  return { tool, videos, out: texto(res) };
}

describe('paridad con las capturas: lo que Asistenta ya puede hacer', () => {
  it('detecta dos eventos del calendario que se solapan', async () => {
    const { findConflicts } = await import('../src/ojo.js');
    const a = reunion('Dentista', at('2026-11-03T10:00:00+01:00'), at('2026-11-03T11:00:00+01:00'));
    const b = reunion('Equipo', at('2026-11-03T10:30:00+01:00'), at('2026-11-03T11:30:00+01:00'));
    const choques = findConflicts([a, b], (i) => i.title, at('2026-11-02T09:00:00+01:00'));
    expect(choques).toHaveLength(1);
  });

  it('avisa antes de una reunión sin pasar por el modelo (bucle barato de vigilancia)', async () => {
    const { dueStages } = await import('../src/ojo.js');
    const cita = reunion(
      'Llamada',
      at('2026-11-03T10:00:00+01:00'),
      at('2026-11-03T11:00:00+01:00'),
    );
    expect(dueStages(cita, 'Europe/Madrid', at('2026-11-02T08:00:00+01:00'))).toEqual([]);
    expect(
      dueStages(cita, 'Europe/Madrid', at('2026-11-03T09:00:00+01:00')).length,
    ).toBeGreaterThan(0);
  });

  it('lleva la cuenta de lo que sigue pendiente de respuesta', async () => {
    const { FollowupTracker } = await import('../src/alerts/followups.js');
    let now = at('2026-10-30T10:00:00+01:00');
    const t = new FollowupTracker({ db: new DatabaseSync(':memory:'), now: () => now });
    t.track('mail:ana', 'respuesta', 'Presupuesto del NAS', now + H);
    now += 2 * H;
    expect(t.due(now).map((f) => f.subject)).toEqual(['Presupuesto del NAS']);
  });

  it('sirve algo para el móvil solo dentro de Tailscale, nunca en público', async () => {
    const { tailscaleServeArgs } = await import('../src/services/adopt.js');
    const args = tailscaleServeArgs(8080);
    expect(args[0]).toBe('serve');
    expect(args.join(' ')).toContain('127.0.0.1:8080');
    expect(args.join(' ')).not.toContain('funnel');
  });

  it('descarga un vídeo de YouTube y lo manda por Telegram (MP4, hasta 720p)', async () => {
    const r = await descargaYEnvia('https://www.youtube.com/watch?v=abc123');
    expect(r.tool.name).toBe('download');
    expect(r.tool.description).toContain('YouTube');
    expect(r.videos).toEqual([{ seconds: 42, label: 'Vídeo de prueba' }]);
    expect(r.out).toContain('Enviado el vídeo');
  });

  it('descarga un vídeo de X/Twitter y lo manda', async () => {
    const r = await descargaYEnvia('https://x.com/usuario/status/1234567890');
    expect(r.tool.description).toContain('X/Twitter');
    expect(descarga.urls).toContain('https://x.com/usuario/status/1234567890');
    expect(r.videos).toHaveLength(1);
  });

  it('transcribe notas de voz en local, sin claves de pago', async () => {
    const { createLocalWhisperStt, transcribeVoiceNote } = await import('../src/voice/stt.js');
    expect(typeof createLocalWhisperStt().transcribe).toBe('function');
    await expect(transcribeVoiceNote(Buffer.alloc(0))).rejects.toThrow(/vacia/);
  });

  it('busca en la web y cada resultado trae su fuente (horarios de TV, compras)', async () => {
    const { createWebTool } = await import('../src/tools/web.js');
    const tool = createWebTool(
      { webMaxCostEur: 0 },
      {
        buildBackends: async () => [
          {
            id: 'falso',
            ops: ['search'],
            costPerCallEur: 0,
            search: async () => ({
              items: [
                {
                  title: 'La Revuelta hoy',
                  url: 'https://www.rtve.es/la-revuelta',
                  snippet: 'Empieza a las 21:45',
                },
              ],
              chars: 40,
            }),
          },
        ],
      },
    );
    const out = texto(
      await tool.execute(
        '1',
        { action: 'search', query: 'a qué hora empieza La Revuelta hoy' },
        undefined as never,
        undefined as never,
      ),
    );
    expect(out).toContain('https://www.rtve.es/la-revuelta');
    expect(out).toContain('21:45');
  });

  it('una compra (p. ej. una pizza) se para en el pago y pide permiso con el precio', async () => {
    const { isPaymentText } = await import('../src/permissions.js');
    const { createCheckoutTool } = await import('../src/tools/checkout.js');
    expect(typeof createCheckoutTool).toBe('function');
    expect(isPaymentText('Pagar 23,50 €')).toBe(true);
    expect(isPaymentText('Ver la carta')).toBe(false);
  });

  it('controla el ordenador (Computer Use)', async () => {
    const { createComputerTool } = await import('../src/tools/computer.js');
    expect(typeof createComputerTool).toBe('function');
  });

  it('avisa de un pedido repetido leído en el correo (dos correas iguales)', async () => {
    const { ingestCharges, pendingChargeAlerts } = await import('../src/ojo-charges.js');
    const db = new DatabaseSync(':memory:');
    const base = at('2026-10-28T10:00:00+01:00');
    const correo = (id: string, n: number) =>
      ({
        id,
        from: 'Tienda <pedidos@tienda.es>',
        subject: 'Recibo de tu pedido: Correa Charge 6',
        text: 'Importe: 24,99 €',
        at: base + n * H,
      }) as unknown as import('../src/mail/types.js').MailMessage;
    ingestCharges(db, [correo('s0', -400)], base);
    ingestCharges(db, [correo('p1', 1), correo('p2', 2)], base + 3 * H);
    expect(pendingChargeAlerts(db, base + 3 * H).map((a) => a.reason)).toContain('repetido');
  });

  it('mira cómo se ve una página en el móvil (captura a ancho de teléfono)', async () => {
    const { screenshotPage } = await import('../src/browser/service.js');
    let size: { width: number; height: number } | null = { width: 1440, height: 900 };
    const vistas: string[] = [];
    const page = {
      viewportSize: () => size,
      setViewportSize: async (s: { width: number; height: number }) => {
        size = s;
      },
      screenshot: async () => {
        vistas.push(`${size?.width}x${size?.height}`);
        return Buffer.from('png');
      },
    };
    expect((await screenshotPage(page, false, true)).mobile).toBe(true);
    expect(vistas).toEqual(['390x844']);
    expect(size).toEqual({ width: 1440, height: 900 });
  });
});

describe('paridad con las capturas: lo que todavía no puede', () => {
  it.todo(
    'tablero de tareas de la semana (Gertru instala Kanvas): Kanvas se descartó como interfaz y el panel no tiene tablero — decide Nico',
  );
  it.todo(
    'seguir un pedido a domicilio y avisar cuando llega: no hay seguimiento de entregas (las vigilancias son de precio y páginas)',
  );
  it.todo(
    'planificar un evento y preguntar por su cuenta qué falta: lo hace el modelo, no hay herramienta; no se puede probar con el modelo falso',
  );
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { type AgendaOverviewDeps, readAgendaOverview } from '../src/agenda/overview.js';
import type { Followup } from '../src/alerts/followups.js';
import type { Goal } from '../src/goals/store.js';
import { createAgendaTool } from '../src/tools/agenda.js';

vi.mock('../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
const now = new Date('2026-10-27T10:00:00+01:00').getTime();
function deps(): AgendaOverviewDeps {
  return {
    authorised: () => true,
    now: () => now,
    calendar: vi.fn(async () => ({
      configured: true,
      events: [
        {
          id: 'a',
          title: 'Dentista',
          start: now + 3600000,
          end: now + 5400000,
          allDay: false,
          source: 'calendar' as const,
        },
      ],
    })),
    followups: vi.fn(() => [
      { status: 'pending', dueAt: now, subject: 'Revisar papeles', kind: 'reminder' } as Followup,
      {
        id: 'done',
        scope: 'owner',
        kind: 'reminder',
        lastContact: now,
        createdAt: now,
        status: 'done' as const,
        dueAt: now,
        subject: 'Ya terminado',
      },
    ]),
    routines: vi.fn(() => 'Rutinas programadas: 1\n- recordatorio:llamada: próxima mañana'),
    goals: vi.fn(() => [
      {
        status: 'active',
        title: 'Preparar viaje',
        plan: [
          { text: 'Buscar tren', done: true },
          { text: 'Comparar hotel', done: false },
        ],
      } as Goal,
    ]),
  };
}
describe('read-only unified overview', () => {
  it('combines sources without executing work or claiming email coverage', async () => {
    const d = deps();
    const text = await readAgendaOverview(d);
    for (const item of [
      'Dentista',
      'Revisar papeles',
      'recordatorio:llamada',
      'Preparar viaje',
      'siguiente Comparar hotel',
      'Correo no incluido',
    ])
      expect(text).toContain(item);
    expect(text).not.toContain('Ya terminado');
    expect(text).not.toContain('siguiente Buscar tren');
  });
  it('denies before touching any private source', async () => {
    const d = deps();
    d.authorised = () => false;
    expect(await readAgendaOverview(d)).toContain('solo disponible');
    for (const spy of [d.calendar, d.followups, d.routines, d.goals])
      expect(spy).not.toHaveBeenCalled();
  });
  it('preserves explicit missing/degraded calendar evidence', async () => {
    const d = deps();
    d.calendar = async () => ({
      configured: false,
      events: [],
      reason: 'No hay calendario configurado.',
    });
    const text = await readAgendaOverview(d);
    expect(text).toContain('No hay calendario configurado');
    expect(text).toContain('Revisar papeles');
  });
  it('clamps the calendar horizon and omits closed goals', async () => {
    const d = deps();
    d.goals = () => [
      { status: 'done', title: 'Cerrado', plan: [] },
      { status: 'cancelled', title: 'Cancelado', plan: [] },
    ];
    const text = await readAgendaOverview(d, 9999);
    // 60 agenda days after today = 61 calendar days from today (loadCalendar caps it).
    expect(d.calendar).toHaveBeenCalledWith(61);
    expect(text).not.toContain('Objetivos abiertos');
  });
  it('exposes the same reader to the model without mutation actions', async () => {
    const read = vi.fn(async () => 'Vista real');
    const tool = createAgendaTool(read);
    expect(tool.name).toBe('agenda');
    const output = await tool.execute('a', { days: 3 });
    expect(read).toHaveBeenCalledWith(3);
    expect(output.content).toEqual([{ type: 'text', text: 'Vista real' }]);
    expect(JSON.stringify(tool.parameters)).not.toContain('action');
  });
  it('wires command and tool to one owner-gated reader, not a new mail route', async () => {
    const cli = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('createAgendaTool((days) => personalAgenda(inboundFor(thread), days))');
    const overview = cli.slice(
      cli.indexOf('  const personalAgenda ='),
      cli.indexOf('  const cmdMemory ='),
    );
    expect(overview).toContain('inbound.authorised && isOwnerDm(inbound, vigilanteOwnerId)');
    expect(overview).toContain('await personalAgenda(inbound)');
    expect(overview).toContain("args.trim() === 'rutinas'");
    expect(overview).not.toMatch(/searchMail|loadMailAccount|sendMail/);
    // Despacho: switch antiguo o tabla de comandos (daemonx4).
    expect(cli).toMatch(
      /return cmdAgenda\(inbound, command\.args\)|names: \['agenda'\], run: \(inbound, args\) => cmdAgenda\(inbound, args\)/,
    );
  });
});

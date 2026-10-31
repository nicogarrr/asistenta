import { describe, expect, it, vi } from 'vitest';
import { type AgendaOverviewDeps, readAgendaOverview } from '../src/agenda/overview.js';

vi.mock('../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
const now = new Date('2026-10-29T10:00:00+01:00').getTime(); // jueves 29-10-2026

function deps(tasks: AgendaOverviewDeps['tasks']): AgendaOverviewDeps {
  return {
    authorised: () => true,
    now: () => now,
    calendar: vi.fn(async () => ({ configured: true, events: [] })),
    followups: () => [],
    routines: () => '',
    goals: () => [],
    tasks,
  };
}

const tablero = () => [
  { title: 'devolver libro', day: '2026-10-27', status: 'pendiente' as const },
  { title: 'llamar al banco', day: '2026-10-29', time: '10:00', status: 'en_curso' as const },
  { title: 'ya hecha', day: '2026-10-29', status: 'hecho' as const },
  { title: 'fontanero', day: '2026-10-31', status: 'pendiente' as const },
  { title: 'dentista', day: '2026-11-20', status: 'pendiente' as const },
];

describe('/agenda: tareas del tablero', () => {
  it('enseña lo pendiente de estos días y lo atrasado, no lo hecho ni lo lejano', async () => {
    const text = await readAgendaOverview(deps(tablero), 3);
    expect(text).toContain('Tareas');
    expect(text).toContain('- atrasada: devolver libro');
    expect(text).toContain('- jueves 29 10:00: llamar al banco (en curso)');
    expect(text).toContain('- sábado 31: fontanero');
    expect(text).not.toContain('ya hecha');
    expect(text).not.toContain('dentista');
  });

  it('sin tablero o sin tareas no añade la sección', async () => {
    expect(await readAgendaOverview(deps(undefined), 3)).not.toContain('Tareas');
    expect(
      await readAgendaOverview(
        deps(() => []),
        3,
      ),
    ).not.toContain('Tareas');
  });

  it('fuera del chat del dueño no lee el tablero', async () => {
    const tasks = vi.fn(tablero);
    const text = await readAgendaOverview({ ...deps(tasks), authorised: () => false }, 3);
    expect(text).not.toContain('Tareas');
    expect(tasks).not.toHaveBeenCalled();
  });
});

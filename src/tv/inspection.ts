/** webOS inventory only. No Android packages, shell commands or write transport. */
export interface TvInspectionDeps {
  apps: () => Promise<Array<{ id: string; title: string }>>;
  foreground: () => Promise<{ appId: string; category: string[] }>;
  stats?: () => Promise<unknown>;
}

type Reading<T> = { status: 'ok'; value: T } | { status: 'unavailable' };

async function read<T>(fn: (() => Promise<T>) | undefined): Promise<Reading<T>> {
  if (!fn) return { status: 'unavailable' };
  try {
    return { status: 'ok', value: await fn() };
  } catch {
    // Do not expose transport errors: remote servers can reflect credentials.
    return { status: 'unavailable' };
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function pair(value: unknown, availableKey: string) {
  const data = record(value);
  const total = nonnegative(data.total);
  const available = nonnegative(data[availableKey]);
  if (total === null || available === null || total === 0 || available > total) return null;
  return { totalKiB: total, availableKiB: available, usedKiB: total - available };
}

/** Extract only known metrics, never return the raw API payload or guessed units. */
export function inspectionMetrics(value: unknown) {
  const stats = record(value);
  if (stats.ok === false) throw new Error('Metricas no disponibles.');
  return {
    memory: pair(stats.mem, 'avail'),
    swap: pair(stats.swap, 'free'),
    temperatureCelsius: nonnegative(stats.temp),
    uptimeSeconds: nonnegative(stats.uptime),
  };
}

export async function inspectTv(deps: TvInspectionDeps) {
  const startedAt = new Date().toISOString();
  const [apps, foreground, stats] = await Promise.all([
    read(deps.apps),
    read(deps.foreground),
    read(
      deps.stats
        ? async () => {
            const metrics = inspectionMetrics(await deps.stats?.());
            if (Object.values(metrics).every((value) => value === null)) {
              throw new Error('Metricas no disponibles.');
            }
            return metrics;
          }
        : undefined,
    ),
  ]);
  return {
    platform: 'webos' as const,
    readOnly: true as const,
    startedAt,
    finishedAt: new Date().toISOString(),
    atomic: false as const,
    complete: [apps, foreground, stats].every((r) => r.status === 'ok'),
    apps,
    foreground,
    metrics: stats,
    // Inventory is not proof an app is bloatware or safe to remove.
    changesApplied: false as const,
  };
}

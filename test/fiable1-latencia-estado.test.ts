import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LatencyStats, latencyLine, percentile, secondsEs } from '../src/daemon/latency.js';
import { formatStatus } from '../src/status.js';

describe('/estado dice cuánto tarda en contestar', () => {
  it('mediana, p95 y la más lenta de las últimas respuestas', () => {
    const l = new LatencyStats(100);
    for (const ms of [1000, 2000, 3000, 4000, 30_000]) l.record(ms, 200);
    expect(l.summary()).toEqual({
      count: 5,
      medianMs: 3000,
      p95Ms: 30_000,
      maxMs: 30_000,
      waitMedianMs: 200,
    });
    expect(latencyLine(l.summary())).toBe(
      'Velocidad (últimas 5 respuestas): 3,0 s de mediana, el 95 % en menos de 30,0 s, la más lenta 30,0 s.',
    );
  });

  it('nunca crece: guarda solo las últimas N', () => {
    const l = new LatencyStats(3);
    for (let i = 1; i <= 1000; i++) l.record(i * 1000);
    expect(l.size).toBe(3);
    expect(l.summary()?.medianMs).toBe(999_000);
  });

  it('ignora tiempos imposibles y dice la cola solo si se nota', () => {
    const l = new LatencyStats();
    l.record(Number.NaN);
    l.record(-5);
    expect(l.summary()).toBeNull();
    expect(latencyLine(null)).toContain('aún no he contestado');
    l.record(9000, 6000);
    expect(latencyLine(l.summary())).toContain('esperando en cola 6,0 s de mediana');
    expect(percentile([], 50)).toBe(0);
    expect(secondsEs(65_000)).toBe('1 min 5 s');
    expect(secondsEs(120_000)).toBe('2 min');
  });

  it('formatStatus enseña la línea de velocidad', () => {
    const text = formatStatus({
      version: '1',
      node: 'v24',
      uptimeMs: 1000,
      tools: [],
      log: null,
      pageWatches: 0,
      latency: 'Velocidad (últimas 1 respuesta): 1,0 s de mediana.',
    });
    expect(text).toContain('Velocidad (últimas 1 respuesta)');
  });

  it('el daemon mide cada respuesta de Telegram y /estado no bloquea leyendo el log', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(/latency\.record\(sinceReceived/);
    expect(cli).toMatch(/latency: latencyLine\(latency\.summary\(\)\)/);
    expect(cli).toMatch(/summarizeLog\(await readFile\(/);
    expect(cli).not.toMatch(/summarizeLog\(readFileSync\(/);
  });
});

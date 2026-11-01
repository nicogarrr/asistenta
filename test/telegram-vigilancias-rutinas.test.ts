import { describe, expect, it } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram.js';
import { vigilanciasReply } from '../src/cli.js';
import type { OverviewEntry } from '../src/watch/overview.js';

/** /vigilancias: «⏸ Pausar …» / «▶️ Reanudar …» para las rutinas de este chat (no borra). */
const r = (o: Partial<OverviewEntry>): OverviewEntry => ({
  kind: 'rutina',
  id: 'r',
  label: 'resumen',
  target: '0 9 * * *',
  scope: 'telegram:dm:42#main',
  enabled: true,
  ...o,
});

describe('/vigilancias: pausar y reanudar rutinas', () => {
  it('una rutina activa de este chat trae «⏸ Pausar», que es /cron pausa <nombre>', () => {
    const b = vigilanciasReply([r({})], '42').buttons;
    expect(b?.map((x) => x.label)).toEqual(['⏸ Pausar resumen']);
    expect(b?.map((x) => commandFromCallback(x.action))).toEqual(['/cron pausa resumen']);
  });

  it('una en pausa trae «▶️ Reanudar»', () => {
    const b = vigilanciasReply([r({ enabled: false, label: 'noticias' })], '42').buttons;
    expect(b?.map((x) => commandFromCallback(x.action))).toEqual(['/cron reanudar noticias']);
  });

  it('las globales, las de otro chat y las de otro canal no traen botón', () => {
    const b = vigilanciasReply(
      [r({ scope: '' }), r({ scope: 'telegram:dm:77#main' }), r({ scope: 'whatsapp:dm:42' })],
      '42',
    ).buttons;
    expect(b).toBeUndefined();
  });

  it('ninguno es destructivo y van después de los «📈 Precio»', () => {
    const page: OverviewEntry = {
      kind: 'pagina',
      id: 'a1b2',
      label: 'Zapatillas',
      target: 'https://x.es',
      scope: '42',
      enabled: true,
    };
    const b = vigilanciasReply([r({}), page], '42').buttons ?? [];
    expect(b.map((x) => x.label)).toEqual(['📈 Precio Zapatillas', '⏸ Pausar resumen']);
    for (const x of b) expect(commandFromCallback(x.action)).not.toMatch(/borra|cancela|dejar/);
  });
});

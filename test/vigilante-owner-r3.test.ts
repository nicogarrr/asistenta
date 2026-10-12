import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { resolveOwnerDmChatId, resolveOwnerUserId, startVigilanteLoop } from '../src/vigilante.js';

// Repro del auditor (ronda 3, punto a): con allowlist [owner, otra persona] y solo
// la otra persona activa, la agenda del owner NO puede salir hacia ese DM. Adaptado
// al API final (resolveOwnerUserId + resolveOwnerDmChatId); el escenario es idéntico.
it('multiple permitted people cannot make sole active nonowner the owner', () => {
  const ownerId = resolveOwnerUserId([111, 222], null);
  expect(resolveOwnerDmChatId(['telegram:bot:222'], ownerId)).toBeNull();
});

// Repro del auditor (ronda 3, punto b), verbatim salvo formato: una entrega
// confirmada durante el drain queda marcada; el reinicio no la reenvía.
it('delivered notification during drain remains marked before restart', async () => {
  const db = new DatabaseSync(':memory:');
  let resolve!: (v: boolean) => void;
  let entered = false;
  const sent = new Promise<boolean>((r) => {
    resolve = r;
  });
  const at = Date.now() + 60000;
  const loop = startVigilanteLoop(
    {
      db,
      agenda: async () => ({
        today: [],
        upcoming: [{ title: 'Plazo', kind: 'deadline', where: 'correo', at }],
        pending: [],
        notes: [],
        days: 7,
        generatedAt: Date.now(),
        counts: { calendar: 0, mail: 1, pending: 0 },
      }),
      send: async () => {
        entered = true;
        return sent;
      },
    },
    'Europe/Madrid',
    1000,
    0,
  );
  while (!entered) await new Promise((r) => setTimeout(r, 1));
  const stop = loop.stop();
  resolve(true);
  await stop;
  expect((db.prepare('SELECT count(*) n FROM vigilante_seen').get() as { n: number }).n).toBe(1);
});

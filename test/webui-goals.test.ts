import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { GoalStore } from '../src/goals/store.js';
import { ownerGoals } from '../src/webui/goals.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

describe('panel goals read-only', () => {
  it('filters exact owner chats, preserves threads and omits verbatim', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const store = new GoalStore({ db });
      for (const scope of [
        'telegram:dm:12#main',
        'telegram:dm:12#viaje',
        'telegram:dm:123#main',
        'telegram:group:12#main',
      ])
        store.propose({
          scope,
          title: '<img onerror=alert(1)>',
          verbatim: 'private original',
          plan: [{ text: 'Paso', done: false }],
          cadence: '0 9 * * *',
        });
      const before = store.list();
      const result = ownerGoals(store, 12);
      expect(result).toHaveLength(2);
      expect(result.map((g) => g.thread).sort()).toEqual(['main', 'viaje']);
      expect(result.find((g) => g.thread === 'main')?.panelChatAvailable).toBe(true);
      expect(result.find((g) => g.thread === 'viaje')?.panelChatAvailable).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private original');
      expect(store.list()).toEqual(before);
      expect(() => ownerGoals(store, undefined)).toThrow();
    } finally {
      db.close();
    }
  });
  it('requires Bearer, ignores caller scope and never accepts writes', async () => {
    let calls = 0;
    const deps: WebUiDeps = {
      token: 'test-only',
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
      goals: () => {
        calls++;
        return [{ id: 'owned' }];
      },
    };
    const ui = await startWebUi(deps);
    try {
      expect((await fetch(ui.url + '/api/goals')).status).toBe(401);
      expect(calls).toBe(0);
      const res = await fetch(ui.url + '/api/goals?scope=foreign', {
        headers: { Authorization: 'Bearer test-only' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual([{ id: 'owned' }]);
      expect(
        (
          await fetch(ui.url + '/api/goals', {
            method: 'POST',
            headers: { Authorization: 'Bearer test-only' },
          })
        ).status,
      ).toBe(405);
      expect(calls).toBe(1);
    } finally {
      await ui.close();
    }
  });
  it('returns unavailable when not wired and opaque error when owner cannot resolve', async () => {
    const deps: WebUiDeps = {
      token: 'test-only',
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
    };
    for (const configured of [false, true]) {
      const ui = await startWebUi({
        ...deps,
        ...(configured
          ? {
              goals: () => {
                throw new Error('secret');
              },
            }
          : {}),
      });
      try {
        const res = await fetch(ui.url + '/api/goals', {
          headers: { Authorization: 'Bearer test-only' },
        });
        expect(res.status).toBe(configured ? 500 : 503);
        expect(await res.text()).not.toContain('secret');
      } finally {
        await ui.close();
      }
    }
  });
});

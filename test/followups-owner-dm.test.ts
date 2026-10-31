import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as followups from '../src/alerts/followups.js';

const mod = followups as unknown as Record<string, unknown>;

describe('vigilante y resumen diario: solo seguimientos del privado del dueño', () => {
  it('cli.ts ya no lee los seguimientos de todos los chats para lo que va al privado', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/followups\.list\(undefined/);
    // Vigilante, resumen diario y la pregunta de «¿qué tal fue?» (close-loop): los tres al privado.
    expect(src.match(/ownerDmFollowups\(followups, ownerDmFollowupKey\(\)\)/g)?.length).toBe(3);
  });

  it('ownerDmFollowups lee solo el chat del dueño y nada si no hay dueño', () => {
    const fn = mod.ownerDmFollowups as (t: unknown, key: string | undefined) => unknown[];
    expect(typeof fn).toBe('function');
    const asked: string[] = [];
    const tracker = {
      forChat: (key: string) => {
        asked.push(key);
        return [{ subject: 'factura' }];
      },
    };
    expect(fn(tracker, 'telegram:bot:42')).toHaveLength(1);
    expect(fn(tracker, undefined)).toEqual([]);
    expect(asked).toEqual(['telegram:bot:42']);
  });

  it('ownerDmKeyFor encuentra el DM y no confunde un grupo', () => {
    const fn = mod.ownerDmKeyFor as (keys: string[], id: string) => string | undefined;
    expect(typeof fn).toBe('function');
    const keys = ['telegram:bot:-1001', 'qa:x:42', 'telegram:bot:42'];
    expect(fn(keys, '42')).toBe('telegram:bot:42');
    expect(fn(keys, '7')).toBeUndefined();
  });
});

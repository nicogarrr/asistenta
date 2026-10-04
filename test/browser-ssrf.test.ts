import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/browser/service.js';
import { isFetchable, isFetchableResolved } from '../src/tools/fetch.js';

describe('browser open refuses local and private destinations', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-ssrf-'));
  const approvals: string[] = [];
  const service = new BrowserService({
    policy: {
      approve: async (_scope, domain) => {
        approvals.push(domain);
        return true;
      },
    },
    profilesDir: join(root, 'profiles'),
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const refused = [
    'http://localhost:8080/',
    'http://127.0.0.1:5432/',
    'http://[::1]/',
    'http://10.1.2.3/',
    'http://172.16.0.9/',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://100.64.1.1/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
  ];

  for (const url of refused) {
    it(`refuses ${url} before asking the user or launching a browser`, async () => {
      await expect(service.open('t#1', url)).rejects.toThrow(/direccion local o privada/);
      expect(approvals).toEqual([]);
    });
  }
});

describe('isFetchable: metadata and internal names', () => {
  it('refuses cloud metadata and internal-only suffixes', () => {
    expect(isFetchable('http://metadata.google.internal/')).toBe(false);
    expect(isFetchable('http://metadata/')).toBe(false);
    expect(isFetchable('http://db.internal/')).toBe(false);
    expect(isFetchable('http://printer.local/')).toBe(false);
  });

  it('does not refuse public names that merely contain those words', () => {
    expect(isFetchable('https://internal.com/')).toBe(true);
    expect(isFetchable('https://local.example.com/')).toBe(true);
    expect(isFetchable('https://metadata.org/')).toBe(true);
  });
});

describe('isFetchableResolved: a public-looking name that resolves to a private IP', () => {
  it('is refused, and a public resolution is allowed', async () => {
    expect(
      await isFetchableResolved('https://evil.example/', async () => ['169.254.169.254']),
    ).toBe(false);
    expect(await isFetchableResolved('https://ok.example/', async () => ['93.184.216.34'])).toBe(
      true,
    );
    expect(
      await isFetchableResolved('https://mixed.example/', async () => [
        '93.184.216.34',
        '10.0.0.1',
      ]),
    ).toBe(false);
  });
});

import { buildSystemPrompt, SYSTEM_PROMPT } from '../src/core/prompt.js';

describe('buildSystemPrompt', () => {
  it('keeps the desktop prompt untouched', () => {
    expect(buildSystemPrompt(true)).toBe(SYSTEM_PROMPT);
  });

  it('server mode drops the Windows claim and says what is not available', () => {
    const p = buildSystemPrompt(false);
    expect(p).not.toContain('Windows machine');
    expect(p).toContain('headless server');
    expect(p).toContain('call download once per link');
    expect(p.split('\n').length).toBeGreaterThan(10);
  });
});

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { EMPLEO_ALLOWED_TOOLS, guardEmpleoTools } from '../src/mcp/empleo.js';
import { filters, jobQuestions, tools } from '../vendor/tech-pay-spain/api/mcp.js';

type Def = { name: string; description: string };

it('remote job index cannot make the local MCP read loopback and an arbitrary port', async () => {
  const urls: string[] = [];
  const job = {
    id: 'jsonld:127.0.0.1:123',
    ats: 'jsonld',
    url: 'https://127.0.0.1:8443/internal',
    title: 'audit',
    company: 'audit',
  };
  await jobQuestions(
    {},
    { id: job.id },
    {
      jobs: async () => ({ jobs: [job] }),
      fetch: async (url: string) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () =>
            '<script type="application/ld+json">{"@type":"JobPosting","description":"fixture"}</script>',
        };
      },
    },
  );
  expect(urls).toEqual([]);
});
it('remote data fields cannot become tool description instructions', () => {
  const data = {
    min_group: 'AUDIT_REMOTE_TEXT',
    min_ranked: 'AUDIT_REMOTE_TEXT',
    sizes: { buckets: ['AUDIT_REMOTE_TEXT'] },
  };
  const definitions = tools(data).filter((t: Def) => EMPLEO_ALLOWED_TOOLS.includes(t.name));
  const published = guardEmpleoTools(
    definitions.map((t: Def) => ({ ...t, name: `mcp_empleo_${t.name}` })) as unknown as Parameters<
      typeof guardEmpleoTools
    >[0],
  );
  expect(JSON.stringify(published)).not.toContain('AUDIT_REMOTE_TEXT');
});
it('the data download has bounded validated egress before parsing', () => {
  const source = readFileSync(
    new URL('../vendor/tech-pay-spain/scripts/mcp-stdio.mjs', import.meta.url),
    'utf8',
  );
  expect(source).toMatch(/redirect:\s*['"]error['"]/);
  expect(source).toMatch(/AbortSignal\.timeout/);
});

const HOSTILE = 'AUDIT_REMOTE_TEXT';
const METADATA_FIELDS = [
  'min_group',
  'min_ranked',
  'quartile_min',
  'round_eur',
  'threshold',
  'min_base',
  'min_global',
  'reported',
  'data_as_of',
  'generated',
] as const;

it('every remote metadata field, hostile or out of range, leaves the published tools and filters clean', () => {
  const values: unknown[] = [HOSTILE, -5, 0, 1e9, 1.5, NaN, {}, [HOSTILE], null];
  for (const field of METADATA_FIELDS) {
    for (const value of values) {
      const data: Record<string, unknown> = {
        roles: [],
        regions: [],
        years: [],
        sizes: { buckets: ['1-50'], as_of: HOSTILE },
        instructions: 'x',
        [field]: value,
      };
      const published = JSON.stringify(
        guardEmpleoTools(
          tools(data)
            .filter((t: Def) => EMPLEO_ALLOWED_TOOLS.includes(t.name))
            .map((t: Def) => ({ ...t, name: `mcp_empleo_${t.name}` })) as unknown as Parameters<
            typeof guardEmpleoTools
          >[0],
        ),
      );
      expect(published).not.toContain(HOSTILE);
      expect(published).not.toMatch(/Infinity|NaN|undefined|null salaries|-5 salaries|1e\+?9/);
      expect(JSON.stringify(filters(data))).not.toContain(HOSTILE);
    }
  }
});

it('a missing or invalid min_ranked and round_eur fall back to the fixed defaults', () => {
  for (const bad of [HOSTILE, -1, 0, 5000, 2.5, undefined]) {
    const description = (tools({ min_ranked: bad, round_eur: bad }) as Def[]).find(
      (t) => t.name === 'top_companies',
    )?.description;
    expect(description).toContain('with fewer than 3 salaries');
  }
  const ok = (tools({ min_ranked: 7 }) as Def[]).find(
    (t) => t.name === 'top_companies',
  )?.description;
  expect(ok).toContain('with fewer than 7 salaries');
});

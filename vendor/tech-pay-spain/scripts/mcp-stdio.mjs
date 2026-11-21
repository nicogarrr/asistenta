#!/usr/bin/env node
// The MCP server over stdio, for agents that start it themselves:
//
//     node scripts/mcp-stdio.mjs                      # _site/ if built, else the live site
//     node scripts/mcp-stdio.mjs path/or/url/of/data.json [path/or/url/of/jobs.json [path/or/url/of/company-cells.json]]
//
// The same code as the public /mcp (api/mcp.js), so local and hosted agents get
// the same answers. The job index is jobs.json beside data.json unless named
// (or TECH_PAY_JOBS), read on the first job tool call; the companies table is
// company-cells.json beside it unless named (or TECH_PAY_COMPANIES), read on the
// first company tool call. Node 22 or newer, no dependencies.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { respond } from "../api/mcp.js";

const BUILT = new URL("../_site/api/v1/data.json", import.meta.url);
const source = process.argv[2] ?? process.env.TECH_PAY_DATA
  ?? (existsSync(BUILT) ? BUILT : "https://spanishtoptechcompanies.com/api/v1/data.json");
const jobsSource = process.argv[3] ?? process.env.TECH_PAY_JOBS
  ?? String(source).replace(/data\.json$/, "jobs.json");
const companiesSource = process.argv[4] ?? process.env.TECH_PAY_COMPANIES
  ?? String(source).replace(/data\.json$/, "company-cells.json");

const read = async (from) => /^https?:/.test(String(from))
  ? (await fetch(from)).json()
  : JSON.parse(readFileSync(/^file:/.test(String(from)) ? fileURLToPath(String(from)) : String(from), "utf8"));

const data = await read(source);
let jobs, companies; // kept once read; a failed read is tried again on the next call
const env = { jobs: async () => (jobs ??= await read(jobsSource)),
              companies: async () => (companies ??= await read(companiesSource)) };

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
    continue;
  }
  const reply = await respond(data, msg, env);
  if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
}

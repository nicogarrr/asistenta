// Server-side events for PostHog: what no browser sends, the agents calling /mcp.
// Vercel serves no function
// from a file whose name starts with "_", so this is only imported.
//
// Like the page: no cookie, no IP and no person profile. The id is the agent's
// random MCP session (api/mcp.js sessionOf) or, without one, a fresh one per
// request; the country comes from Vercel's header, and PostHog's GeoIP is off
// because the address it would see is Vercel's, not the caller's.

const HOST = "https://eu.i.posthog.com";
// The public phc_ token the page already ships (scripts/site.py POSTHOG_TOKEN).
const TOKEN = process.env.POSTHOG_PROJECT_TOKEN || "phc_pZPnNWRnbona6CeHA5pBjQBfLTPng4jetnXHbuSZyGaX";
// Production only: tests, `vercel dev` and previews must not count.
const ON = process.env.VERCEL_ENV === "production";

export function uuidv7() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) { b[i] = ms % 256; ms = Math.floor(ms / 256); }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const CREDENTIAL = "authorization|cookie|set-cookie|x-api-key|token|password|secret|" +
  "(?:api|access|refresh)[-_]?(?:key|token)|client[-_]?secret|private[-_]?key";
const REDACTIONS = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@"],
  [new RegExp(`((?:^|[\\s?&#,{"'])"?(?:${CREDENTIAL}|sig|signature|x-amz-signature)"?\\s*[=:]\\s*"?)[^\\s&#,"'}]+`, "gi"), "$1[redacted]"],
  [/\bph[a-z]_[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[redacted]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted]"],
  [/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, (m) => (m.split(":").length > 3 ? "[redacted]" : m)],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted]"],
  [/(?:\+?\d[\s.-]?){9,19}\d/g, "[redacted]"], // phone and card numbers
];

// Free text an agent wrote, before it leaves: what PostHog's MCP Analytics asks.
export function redact(text, limit = 2048) {
  let out = String(text);
  for (const [pattern, to] of REDACTIONS) out = out.replace(pattern, to);
  return out.slice(0, limit);
}

export const cut = (v, n = 256) => (v === undefined || v === null || v === "" ? undefined : String(v).slice(0, n));

// What every event carries, from the request's headers.
export function origin(headers) {
  return {
    $process_person_profile: false,
    $geoip_disable: true,
    $geoip_country_code: cut(headers["x-vercel-ip-country"], 2),
  };
}

// An event as the capture API takes it; distinct_id defaults to a fresh id.
export const event = (name, properties, distinctId = uuidv7()) => ({
  event: name, distinct_id: distinctId, timestamp: new Date().toISOString(),
  properties: Object.fromEntries(Object.entries(properties).filter(([, v]) => v !== undefined)),
});

// Sends the events and never throws: counting must not change what a caller gets.
export async function capture(events) {
  if (!ON || !events.length) return;
  try {
    await fetch(`${HOST}/batch/`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: TOKEN, batch: events }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.error("posthog capture failed:", e?.message ?? e);
  }
}

// Vercel's waitUntil when it has one, so the reply does not wait for PostHog;
// otherwise the caller awaits the send.
export function after(promise) {
  const context = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
  if (typeof context?.waitUntil === "function") {
    context.waitUntil(promise);
    return undefined;
  }
  return promise;
}

/**
 * The vault login convention of the universal errand runner (capability 3,
 * PR2). Credentials for a site live in the daemon vault under
 * `site:<domain>:<field>` - today `username` and `password`. The convention is
 * the whole contract: plans, proposals, errors and logs name KEYS only, and a
 * value leaves the vault in exactly one place - the browser field it is typed
 * into (browser fill with `secret_key`), masked end to end.
 */

export const LOGIN_KEY_FIELDS = ['username', 'password'] as const;
export type LoginKeyField = (typeof LOGIN_KEY_FIELDS)[number];

/** `site:<domain>:<field>` - the only key shape the gestor accepts for a login. */
export function siteKey(domain: string, field: LoginKeyField): string {
  return `site:${domain}:${field}`;
}

/**
 * Canonical domain for the convention: lowercase, no scheme, path, query,
 * port, userinfo or leading `www.`. Accepts a bare host or a full URL. Returns
 * null when the input cannot name a host. A URL with embedded credentials
 * (`user:pass@host`) parses to its host ONLY: those credentials never reach a
 * key, a message or a log line from here.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('://') || s.includes('/')) {
    try {
      s = new URL(s.includes('://') ? s : `https://${s}`).hostname;
    } catch {
      return null;
    }
  }
  // A bare host can still carry userinfo or a port; both stay out of the key.
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  const colon = s.indexOf(':');
  if (colon !== -1) s = s.slice(0, colon);
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.startsWith('www.')) s = s.slice(4);
  if (!s || !/^[a-z0-9.-]+$/.test(s) || s.includes('..') || s.startsWith('.') || s.endsWith('.')) {
    return null;
  }
  return s;
}

/** Reads `site:<domain>:<field>` back into its parts, or null for any other key. */
export function parseSiteKey(key: string): { domain: string; field: LoginKeyField } | null {
  const m = /^site:([^:]+):(username|password)$/.exec(key.trim().toLowerCase());
  const raw = m?.[1];
  const field = m?.[2];
  if (!raw || (field !== 'username' && field !== 'password')) return null;
  const domain = normalizeDomain(raw);
  if (!domain || domain !== raw) return null;
  return { domain, field };
}

/** The fields of the convention missing from the vault, in canonical order. */
export function missingLoginFields(domain: string, vaultNames: readonly string[]): LoginKeyField[] {
  const names = new Set(vaultNames.map((n) => n.trim().toLowerCase()));
  return LOGIN_KEY_FIELDS.filter((f) => !names.has(siteKey(domain, f)));
}

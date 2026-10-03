// Denied external transports for a disposable test deployment (RR-08).
//
// A restored database copy carries real provider identifiers: mailbox grants,
// Airtable record ids, application references. Code gates provider calls on
// the presence of a key, not on which database is selected, so a copy wired to
// live keys can revoke a real mailbox grant or write a real Airtable record.
// `OUTBOUND_DENY_HOSTS` lists the hostnames (comma separated, exact or
// `.suffix` match) that this process must never reach. Every `fetch` to one of
// them fails before the request is sent, is counted, and the failure code is
// the only thing a log sees. Unset in production: nothing is installed.
//
// The guard wraps the global fetch once per process. It is installed from
// `instrumentation.ts` for the Next.js server and from `installOutboundGuard`
// for workers and scripts that import the worker library.
const STATE_KEY = Symbol.for("tt.outbound-guard");
type State = { hosts: string[]; denied: Map<string, number>; original: typeof fetch };

export const DENIED_CODE = "outbound_denied";

export function deniedHosts(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.OUTBOUND_DENY_HOSTS;
  if (!raw) return [];
  const hosts = raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of hosts) if (!/^\.?[a-z0-9.-]+$/.test(h)) throw Error("outbound_deny_hosts_invalid");
  return hosts;
}

export function hostDenied(hostname: string, hosts: string[]): boolean {
  const h = hostname.toLowerCase();
  return hosts.some((d) => (d.startsWith(".") ? h === d.slice(1) || h.endsWith(d) : h === d));
}

function requestHost(input: RequestInfo | URL): string | null {
  try {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** Installs the guard when `OUTBOUND_DENY_HOSTS` is set. Idempotent; returns the
 * denied host list (empty when nothing is installed). */
export function installOutboundGuard(env: Record<string, string | undefined> = process.env): string[] {
  const hosts = deniedHosts(env);
  const g = globalThis as unknown as Record<symbol, State | undefined> & { fetch: typeof fetch };
  const existing = g[STATE_KEY];
  if (existing) {
    existing.hosts = hosts;
    return hosts;
  }
  if (!hosts.length) return hosts;
  const state: State = { hosts, denied: new Map(), original: g.fetch };
  g[STATE_KEY] = state;
  const guarded: typeof fetch = (input, init) => {
    const host = requestHost(input);
    if (host && hostDenied(host, state.hosts)) {
      state.denied.set(host, (state.denied.get(host) ?? 0) + 1);
      return Promise.reject(Object.assign(Error(`${DENIED_CODE}:${host}`), { code: DENIED_CODE }));
    }
    return state.original(input, init);
  };
  g.fetch = guarded;
  return hosts;
}

/** Counts of denied requests per host since install (for test evidence). */
export function deniedRequests(): Record<string, number> {
  const state = (globalThis as unknown as Record<symbol, State | undefined>)[STATE_KEY];
  return state ? Object.fromEntries(state.denied) : {};
}

export const isOutboundDenied = (error: unknown): boolean =>
  (error as { code?: string } | null)?.code === DENIED_CODE;

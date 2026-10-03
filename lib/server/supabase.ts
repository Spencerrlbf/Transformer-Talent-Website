import { transitionRequestHeaders } from './person-transition/context';
import { assertServerTarget } from './person/target';

const url = () => {
  const u = process.env.SUPABASE_URL;
  if (!u) throw new Error("SUPABASE_URL not configured");
  // The selected project must own this URL whenever normalized storage is on.
  assertServerTarget();
  return u;
};

const key = () => {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!k) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  return k;
};

export async function sbRest(
  path: string,
  init: RequestInit & { prefer?: string } = {}
): Promise<Response> {
  const headers = new Headers({
    apikey: key(),
    Authorization: `Bearer ${key()}`,
    "Content-Type": "application/json",
    ...(init.prefer ? { Prefer: init.prefer } : {}),
  });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  // Only the trusted async server context supplies work credentials. Caller
  // HeadersInit can be an object, array or Headers, with arbitrary casing.
  headers.delete('x-person-work-id');
  headers.delete('x-person-work-token');
  const admission = transitionRequestHeaders();
  for (const [name, value] of Object.entries(admission)) headers.set(name, value);
  // Initial claims and later lifecycle RPCs carry the token in JSON, even
  // before/without an async admission context. Never redirect those bodies.
  const carriesWork = !!admission['x-person-work-id'] ||
    /^rpc\/person_(?:transition|application_work)_/.test(path);
  return fetch(`${url()}/rest/v1/${path}`, {
    // A socket killed by machine sleep otherwise hangs its await forever —
    // observed holding a sourcing run's lease hostage overnight. No PostgREST
    // call here legitimately takes a minute.
    signal: init.signal ?? AbortSignal.timeout(60_000),
    ...init,
    headers,
    ...(carriesWork ? { redirect: 'error' as const } : {}),
  });
}

export async function sbInsert<T>(
  table: string,
  row: Record<string, unknown>,
  returning = false
): Promise<T | null> {
  const res = await sbRest(table, {
    method: "POST",
    body: JSON.stringify(row),
    prefer: returning ? "return=representation" : "return=minimal",
  });
  if (!res.ok) {
    throw new Error(`insert ${table} failed: ${res.status} ${await res.text()}`);
  }
  if (!returning) return null;
  const rows = (await res.json()) as T[];
  return rows[0] ?? null;
}

export async function sbRpc<T>(
  fn: string,
  args: Record<string, unknown>
): Promise<T> {
  const res = await sbRest(`rpc/${fn}`, {
    method: "POST",
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`rpc ${fn} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

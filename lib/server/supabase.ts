const url = () => {
  const u = process.env.SUPABASE_URL;
  if (!u) throw new Error("SUPABASE_URL not configured");
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
  const headers: Record<string, string> = {
    apikey: key(),
    Authorization: `Bearer ${key()}`,
    "Content-Type": "application/json",
    ...(init.prefer ? { Prefer: init.prefer } : {}),
    ...((init.headers as Record<string, string>) || {}),
  };
  return fetch(`${url()}/rest/v1/${path}`, {
    // A socket killed by machine sleep otherwise hangs its await forever —
    // observed holding a sourcing run's lease hostage overnight. No PostgREST
    // call here legitimately takes a minute.
    signal: init.signal ?? AbortSignal.timeout(60_000),
    ...init,
    headers,
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

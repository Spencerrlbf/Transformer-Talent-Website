// Candidate lists ("★" is the built-in Shortlist — same machinery as any
// named list) and manual role attachments (the bulk bar's "Add to a job").
// Shared across the org's seats with who-added attribution, like notes.
import { sbInsert, sbRest } from "./supabase";

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;
export const SHORTLIST_NAME = "Shortlist";

export type ListRow = {
  id: string;
  name: string;
  builtin: boolean;
  createdByEmail: string;
  createdAt: string;
  count: number;
};

export type RowListEntry = {
  id: string;
  name: string;
  builtin: boolean;
  addedByEmail: string;
  addedAt: string;
};

/** Keep only keys that really belong to this org (two IN queries, not N). */
async function keysInOrg(orgId: string, keys: string[]): Promise<string[]> {
  const valid = [...new Set(keys.filter((k) => KEY_RE.test(k)))].slice(0, 1000);
  const appIds = valid.filter((k) => k.startsWith("app_")).map((k) => k.slice(4));
  const srcIds = valid.filter((k) => k.startsWith("src_")).map((k) => k.slice(4));
  const inList = (ids: string[]) => ids.map((i) => `"${i}"`).join(",");
  const [apps, srcs] = await Promise.all([
    appIds.length
      ? sbRest(`website_applications?organization_id=eq.${orgId}&id=in.(${inList(appIds)})&select=id`)
      : null,
    srcIds.length
      ? sbRest(`sourced_candidates?organization_id=eq.${orgId}&id=in.(${inList(srcIds)})&select=id`)
      : null,
  ]);
  const ok = new Set<string>();
  if (apps?.ok) for (const r of (await apps.json()) as { id: string }[]) ok.add(`app_${r.id}`);
  if (srcs?.ok) for (const r of (await srcs.json()) as { id: string }[]) ok.add(`src_${r.id}`);
  return valid.filter((k) => ok.has(k));
}

/** The org's built-in Shortlist, created on first touch. */
export async function ensureShortlist(orgId: string): Promise<string | null> {
  const res = await sbRest(
    `candidate_lists?organization_id=eq.${orgId}&builtin=is.true&select=id&limit=1`
  );
  const [row] = res.ok ? ((await res.json()) as { id: string }[]) : [];
  if (row) return row.id;
  const made = await sbInsert<{ id: string }>(
    "candidate_lists",
    { organization_id: orgId, name: SHORTLIST_NAME, builtin: true },
    true
  ).catch(async () => {
    // Race with a parallel first-touch: the winner's row is the answer.
    const again = await sbRest(
      `candidate_lists?organization_id=eq.${orgId}&builtin=is.true&select=id&limit=1`
    );
    const [r] = again.ok ? ((await again.json()) as { id: string }[]) : [];
    return r ?? null;
  });
  return made?.id ?? null;
}

/** Resolve a list the caller may act on; "shortlist" is an alias for the
 *  built-in one (the drawer's star doesn't need to fetch the list id). */
export async function resolveList(
  orgId: string,
  idOrAlias: string
): Promise<{ id: string; builtin: boolean } | null> {
  if (idOrAlias === "shortlist") {
    const id = await ensureShortlist(orgId);
    return id ? { id, builtin: true } : null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(idOrAlias)) return null;
  const res = await sbRest(
    `candidate_lists?id=eq.${idOrAlias}&organization_id=eq.${orgId}&select=id,builtin&limit=1`
  );
  const [row] = res.ok ? ((await res.json()) as { id: string; builtin: boolean }[]) : [];
  return row ?? null;
}

export async function listLists(orgId: string): Promise<ListRow[]> {
  await ensureShortlist(orgId);
  const [listsRes, membersRes] = await Promise.all([
    sbRest(
      `candidate_lists?organization_id=eq.${orgId}` +
        `&select=id,name,builtin,created_by_email,created_at&order=builtin.desc,created_at.asc&limit=200`
    ),
    sbRest(`candidate_list_members?organization_id=eq.${orgId}&select=list_id&limit=10000`),
  ]);
  const lists = listsRes.ok
    ? ((await listsRes.json()) as {
        id: string;
        name: string;
        builtin: boolean;
        created_by_email: string;
        created_at: string;
      }[])
    : [];
  const counts = new Map<string, number>();
  if (membersRes.ok) {
    for (const m of (await membersRes.json()) as { list_id: string }[]) {
      counts.set(m.list_id, (counts.get(m.list_id) || 0) + 1);
    }
  }
  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    builtin: l.builtin,
    createdByEmail: l.created_by_email,
    createdAt: l.created_at,
    count: counts.get(l.id) || 0,
  }));
}

/** Create a list; an existing same-name list (any case) is returned instead
 *  of an error, so type-to-create is idempotent. */
export async function createList(
  orgId: string,
  name: string,
  user: { id: string; email: string }
): Promise<{ id: string; name: string } | { error: string }> {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!clean) return { error: "Name the list first." };
  const made = await sbInsert<{ id: string; name: string }>(
    "candidate_lists",
    { organization_id: orgId, name: clean, created_by: user.id, created_by_email: user.email },
    true
  ).catch(async () => {
    const res = await sbRest(
      `candidate_lists?organization_id=eq.${orgId}&name=ilike.${encodeURIComponent(clean)}&select=id,name&limit=1`
    );
    const [r] = res.ok ? ((await res.json()) as { id: string; name: string }[]) : [];
    return r ?? null;
  });
  return made ?? { error: "Could not create the list. Try again." };
}

export async function renameList(
  orgId: string,
  id: string,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!clean) return { ok: false, error: "Name the list first." };
  const res = await sbRest(
    `candidate_lists?id=eq.${id}&organization_id=eq.${orgId}&builtin=is.false`,
    { method: "PATCH", body: JSON.stringify({ name: clean }), prefer: "return=representation" }
  );
  if (!res.ok) return { ok: false, error: "name_taken" };
  return ((await res.json()) as unknown[]).length > 0 ? { ok: true } : { ok: false, error: "not_found" };
}

/** Delete a (non-builtin) list; memberships cascade, people are untouched. */
export async function deleteList(orgId: string, id: string): Promise<boolean> {
  const res = await sbRest(
    `candidate_lists?id=eq.${id}&organization_id=eq.${orgId}&builtin=is.false`,
    { method: "DELETE", prefer: "return=representation" }
  );
  if (!res.ok) return false;
  return ((await res.json()) as unknown[]).length > 0;
}

export async function addMembers(
  orgId: string,
  listId: string,
  keys: string[],
  user: { id: string; email: string }
): Promise<number> {
  const valid = await keysInOrg(orgId, keys);
  if (!valid.length) return 0;
  const res = await sbRest(`candidate_list_members?on_conflict=list_id,candidate_key`, {
    method: "POST",
    body: JSON.stringify(
      valid.map((k) => ({
        list_id: listId,
        organization_id: orgId,
        candidate_key: k,
        added_by: user.id,
        added_by_email: user.email,
      }))
    ),
    prefer: "resolution=ignore-duplicates,return=minimal",
  });
  return res.ok ? valid.length : 0;
}

export async function removeMembers(orgId: string, listId: string, keys: string[]): Promise<boolean> {
  const valid = [...new Set(keys.filter((k) => KEY_RE.test(k)))].slice(0, 1000);
  if (!valid.length) return true;
  const res = await sbRest(
    `candidate_list_members?list_id=eq.${listId}&organization_id=eq.${orgId}` +
      `&candidate_key=in.(${valid.map((k) => `"${k}"`).join(",")})`,
    { method: "DELETE" }
  );
  return res.ok;
}

/** Every membership in the org, keyed by candidate — attached to list rows. */
export async function membershipByKey(orgId: string): Promise<Map<string, RowListEntry[]>> {
  const res = await sbRest(
    `candidate_list_members?organization_id=eq.${orgId}` +
      `&select=candidate_key,added_by_email,added_at,candidate_lists(id,name,builtin)&limit=10000`
  );
  const out = new Map<string, RowListEntry[]>();
  if (!res.ok) return out;
  const rows = (await res.json()) as {
    candidate_key: string;
    added_by_email: string;
    added_at: string;
    candidate_lists: { id: string; name: string; builtin: boolean } | null;
  }[];
  for (const r of rows) {
    if (!r.candidate_lists) continue;
    const entry: RowListEntry = {
      id: r.candidate_lists.id,
      name: r.candidate_lists.name,
      builtin: r.candidate_lists.builtin,
      addedByEmail: r.added_by_email,
      addedAt: r.added_at,
    };
    out.set(r.candidate_key, [...(out.get(r.candidate_key) || []), entry]);
  }
  return out;
}

// ---- manual role attachments ("Add to a job") ----

/** Attach candidates to an org role; idempotent. Returns attached count. */
export async function addAttachments(
  orgId: string,
  jobId: string,
  keys: string[],
  user: { id: string; email: string }
): Promise<{ ok: boolean; count: number; error?: string }> {
  if (!/^[\w-]{1,40}$/.test(jobId)) return { ok: false, count: 0, error: "bad_job" };
  const jobRes = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}&select=external_id&limit=1`
  );
  const [job] = jobRes.ok ? ((await jobRes.json()) as { external_id: string }[]) : [];
  if (!job) return { ok: false, count: 0, error: "not_found" };
  const valid = await keysInOrg(orgId, keys);
  if (!valid.length) return { ok: false, count: 0, error: "no_candidates" };
  const res = await sbRest(`role_attachments?on_conflict=organization_id,candidate_key,job_id`, {
    method: "POST",
    body: JSON.stringify(
      valid.map((k) => ({
        organization_id: orgId,
        candidate_key: k,
        job_id: jobId,
        added_by: user.id,
        added_by_email: user.email,
      }))
    ),
    prefer: "resolution=ignore-duplicates,return=minimal",
  });
  return res.ok ? { ok: true, count: valid.length } : { ok: false, count: 0, error: "save_failed" };
}

/** All manual attachments in the org, keyed by candidate. */
export async function attachmentsByKey(orgId: string): Promise<Map<string, string[]>> {
  const res = await sbRest(
    `role_attachments?organization_id=eq.${orgId}&select=candidate_key,job_id&limit=10000`
  );
  const out = new Map<string, string[]>();
  if (!res.ok) return out;
  for (const r of (await res.json()) as { candidate_key: string; job_id: string }[]) {
    out.set(r.candidate_key, [...(out.get(r.candidate_key) || []), r.job_id]);
  }
  return out;
}

/** One candidate's manual attachments (the drawer's detail view). */
export async function attachmentsForKey(
  orgId: string,
  key: string
): Promise<{ jobId: string; addedAt: string }[]> {
  if (!KEY_RE.test(key)) return [];
  const res = await sbRest(
    `role_attachments?organization_id=eq.${orgId}&candidate_key=eq.${key}&select=job_id,added_at`
  );
  if (!res.ok) return [];
  return ((await res.json()) as { job_id: string; added_at: string }[]).map((r) => ({
    jobId: r.job_id,
    addedAt: r.added_at,
  }));
}

/** Is this candidate on the built-in Shortlist? (drawer header star) */
export async function isShortlisted(orgId: string, key: string): Promise<boolean> {
  if (!KEY_RE.test(key)) return false;
  const res = await sbRest(
    `candidate_list_members?organization_id=eq.${orgId}&candidate_key=eq.${key}` +
      `&candidate_lists.builtin=is.true&select=list_id,candidate_lists!inner(builtin)&limit=1`
  );
  if (!res.ok) return false;
  return ((await res.json()) as unknown[]).length > 0;
}

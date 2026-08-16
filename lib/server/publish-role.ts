// Publish/republish one org role from the dashboard: generate the matching
// profile (screening questions included), upsert the org_roles row, and
// refresh job_embeddings with the same hash-dedupe the sync script uses.
// Everything content-shaped comes from roles-pipeline so dashboard-created
// roles are byte-compatible with Notion-synced ones.
import crypto from "node:crypto";
import { sbRest } from "./supabase";
import {
  generateMatchingProfile,
  orgRoleRow,
  facetTexts,
  embedTexts,
  EMBED_MODEL,
  EMBED_DIMS,
  type RoleInput,
  type MatchingProfile,
} from "./roles-pipeline";

export type SkillSpec = { skill: string; must_have: boolean; alternates: string[] };

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function sanitizeSkills(input: unknown): SkillSpec[] {
  if (!Array.isArray(input)) return [];
  const out: SkillSpec[] = [];
  for (const s of input.slice(0, 20)) {
    const skill = String((s as Record<string, unknown>)?.skill || "").trim().slice(0, 60);
    if (!skill) continue;
    const alternates = Array.isArray((s as Record<string, unknown>).alternates)
      ? ((s as Record<string, unknown>).alternates as unknown[])
          .map((a) => String(a).trim().slice(0, 60))
          .filter(Boolean)
          .slice(0, 5)
      : [];
    out.push({ skill, must_have: Boolean((s as Record<string, unknown>).must_have), alternates });
  }
  return out;
}

export async function publishOrgRole(
  organizationId: string,
  role: RoleInput,
  skills: SkillSpec[],
  source: string
): Promise<{ orgRoleId: string; profile: MatchingProfile }> {
  const profile = await generateMatchingProfile(role);

  const row = { ...orgRoleRow(organizationId, role, profile, source), skills };
  const up = await sbRest("org_roles?on_conflict=organization_id,external_id", {
    method: "POST",
    body: JSON.stringify(row),
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  if (!up.ok) throw new Error(`org_roles upsert failed: ${up.status} ${await up.text()}`);

  const sel = await sbRest(
    `org_roles?organization_id=eq.${organizationId}&external_id=eq.${role.jobId}&select=id`
  );
  const [dbRole] = (await sel.json()) as { id: string }[];
  if (!dbRole) throw new Error("org_roles row missing after upsert");

  // Refresh embeddings: hash-dedupe, remove superseded, embed only new text.
  const facets = facetTexts(role, profile);
  const wanted = Object.entries(facets)
    .filter(([, content]) => content)
    .map(([facet, content]) => ({
      org_role_id: dbRole.id,
      facet,
      content,
      content_hash: sha(content),
    }));
  const exRes = await sbRest(
    `job_embeddings?org_role_id=eq.${dbRole.id}&select=id,facet,content_hash`
  );
  const existing = exRes.ok
    ? ((await exRes.json()) as { id: string; facet: string; content_hash: string }[])
    : [];
  const wantKeys = new Set(wanted.map((w) => `${w.facet}|${w.content_hash}`));
  const haveKeys = new Set(existing.map((e) => `${e.facet}|${e.content_hash}`));
  for (const e of existing) {
    if (!wantKeys.has(`${e.facet}|${e.content_hash}`)) {
      await sbRest(`job_embeddings?id=eq.${e.id}`, { method: "DELETE", prefer: "return=minimal" });
    }
  }
  const todo = wanted.filter((w) => !haveKeys.has(`${w.facet}|${w.content_hash}`));
  if (todo.length) {
    const vectors = await embedTexts(todo.map((t) => t.content));
    const ins = await sbRest("job_embeddings?on_conflict=org_role_id,facet,content_hash", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify(
        todo.map((t, i) => ({
          ...t,
          model: EMBED_MODEL,
          dimensions: EMBED_DIMS,
          embedding: JSON.stringify(vectors[i]),
        }))
      ),
    });
    if (!ins.ok) throw new Error(`job_embeddings insert failed: ${ins.status} ${await ins.text()}`);
  }

  return { orgRoleId: dbRole.id, profile };
}

// Next numeric external id for an org (dashboard-created roles).
export async function nextExternalId(organizationId: string): Promise<string> {
  const res = await sbRest(`org_roles?organization_id=eq.${organizationId}&select=external_id`);
  const rows = res.ok ? ((await res.json()) as { external_id: string }[]) : [];
  let max = 0;
  for (const r of rows) {
    const n = parseInt(r.external_id, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

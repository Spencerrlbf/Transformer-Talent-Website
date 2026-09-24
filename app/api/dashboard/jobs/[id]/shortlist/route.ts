import { NextRequest, NextResponse } from "next/server";
import { requireMember } from "@/lib/server/dashboard-auth";
import { sbRest } from "@/lib/server/supabase";

// The role's shortlist (Phase 2): who is worth judging, by code, in rank
// order, with the reasons. Org-scoped through the role.

type Params = { params: Promise<{ id: string }> };

export interface ShortlistRow {
  candidateKey: string;
  candidateId: string;
  rank: number;
  score: number;
  similarity: number | null;
  keywordHits: number;
  checks: { years: boolean | null; family: boolean | null; top: boolean | null };
  reasons: string[];
  name: string;
  title: string | null;
  company: string | null;
  location: string | null;
  engaged: boolean;
  linkedinUrl: string | null;
}

const ENGAGED = new Set(["directory", "airtable_sync", "website_applicant"]);

export async function GET(req: NextRequest, { params }: Params) {
  const member = await requireMember(req);
  if (!member) return NextResponse.json({ error: "not_a_member" }, { status: 403 });
  const { id } = await params;
  const roleRes = await sbRest(`org_roles?organization_id=eq.${member.org.id}&external_id=eq.${encodeURIComponent(id)}&select=id&limit=1`);
  if (!roleRes.ok) return NextResponse.json({ error: "role_lookup_failed" }, { status: 500 });
  const [role] = (await roleRes.json()) as { id: string }[];
  if (!role) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const listRes = await sbRest(
    `role_shortlists?org_role_id=eq.${role.id}&select=candidate_id,rank,score,similarity,keyword_hits,checks,reasons,built_at&order=rank.asc&limit=500`
  );
  if (!listRes.ok) return NextResponse.json({ error: "shortlist_failed" }, { status: 500 });
  const list = (await listRes.json()) as {
    candidate_id: string; rank: number; score: number; similarity: number | null; keyword_hits: number;
    checks: ShortlistRow["checks"]; reasons: string[]; built_at: string;
  }[];
  if (!list.length) return NextResponse.json({ count: 0, builtAt: null, rows: [] });

  const people = new Map<string, { full_name: string | null; current_title: string | null; current_company: string | null; location: string | null; source: string | null; linkedin_url: string | null }>();
  const ids = list.map((r) => r.candidate_id);
  for (let i = 0; i < ids.length; i += 100) {
    const res = await sbRest(`candidates?id=in.(${ids.slice(i, i + 100).join(",")})&select=id,full_name,current_title,current_company,location,source,linkedin_url`);
    if (!res.ok) continue;
    for (const c of (await res.json()) as { id: string; full_name: string | null; current_title: string | null; current_company: string | null; location: string | null; source: string | null; linkedin_url: string | null }[]) people.set(c.id, c);
  }
  const rows: ShortlistRow[] = list.map((r) => {
    const p = people.get(r.candidate_id);
    return {
      candidateKey: `net_${r.candidate_id}`,
      candidateId: r.candidate_id,
      rank: r.rank,
      score: Number(r.score),
      similarity: r.similarity == null ? null : Number(r.similarity),
      keywordHits: r.keyword_hits,
      checks: r.checks || { years: null, family: null, top: null },
      reasons: r.reasons || [],
      name: p?.full_name || "Unknown",
      title: p?.current_title ?? null,
      company: p?.current_company ?? null,
      location: p?.location ?? null,
      engaged: !!p?.source && ENGAGED.has(p.source),
      linkedinUrl: p?.linkedin_url ?? null,
    };
  });
  return NextResponse.json({ count: rows.length, builtAt: list[0].built_at, rows });
}

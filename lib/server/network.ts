// Network matches: the internal-only surface over the nightly pool matcher.
// match_verdicts (pool candidate × org role, scorecard-shaped verdicts) is
// aggregated person-first: one entry per pool person with all their matched
// roles. STRICTLY Transformer Talent's own view — the API layer refuses any
// other org, and nothing here is ever exposed on client dashboards. The
// "send" path is the only bridge to a client-visible surface: it creates a
// normal website_applications row marked source=transformer_talent, which
// renders in the job's pipeline as an applicant with the Via-TT badge.
import { sbRest, sbInsert } from "./supabase";
import { clientTag, clientReason, TAG_LABEL, type ClientTag } from "./client-reason";
import type { Scorecard } from "./scorecard";

export const TT_ORG_SLUG = "transformer-talent";

export type NetworkMatch = {
  jobId: string;
  title: string;
  company: string | null;
  salary: string | null;
  location: string | null;
  tag: ClientTag;
  tagLabel: string;
  reason: string;
  addedAt: string;
  sentAt: string | null; // already sent to this job via the send button
  /** Client org name a send delivers to (linked roles); null = our own pipeline. */
  sendsTo: string | null;
};

export type NetworkPerson = {
  candidateId: string;
  name: string;
  photoUrl: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  linkedinUrl: string | null;
  email: string | null; // best usable address
  emails: RankedEmail[]; // all usable addresses, best first
  phone: string | null;
  years: number | null;
  latestMatchAt: string; // newest verdict — drives the "new" markers
  matches: NetworkMatch[]; // best fit first
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

const TAG_RANK: Record<ClientTag, number> = { strong: 0, possible: 1, stretch: 2 };

type VerdictRow = {
  candidate_id: string;
  org_role_id: string;
  source: string;
  created_at: string;
  verdict: { qualified?: boolean; scorecard?: Scorecard } | null;
};

type PoolRow = {
  id: string;
  full_name: string | null;
  current_title: string | null;
  current_company: string | null;
  headline: string | null;
  location: string | null;
  linkedin_url: string | null;
  linkedin_username: string | null;
  email: string | null;
  phone: string | null;
  contact: { email?: string | null; phone?: string | null; github?: string | null } | null;
  profile_picture_url: string | null;
  calculated_experience_years: number | null;
  total_experience_years: number | null;
};

const POOL_COLS =
  "id,full_name,current_title,current_company,headline,location,linkedin_url," +
  "linkedin_username,email,phone,contact,profile_picture_url,calculated_experience_years,total_experience_years";

/* ---- pool email resolver -------------------------------------------- */
// Emails live in three places: candidates.email (our own engaged-contact
// data — most trusted), plus the enrichment tables candidate_emails /
// candidate_emails_v2 which carry verification results. Verified-invalid
// addresses NEVER surface; the rest rank: known contact > verified-good
// personal > verified-good business > risky/catch-all (passive candidates'
// work addresses go stale, so personal wins).

export type RankedEmail = { email: string; verified: boolean };

type EmailRow = {
  candidate_id: string;
  email: string | null;
  email_type: string | null;
  is_primary: boolean | null;
  quality: string | null;
  result: string | null;
};

function emailScore(r: EmailRow): number {
  const goodOk = r.quality === "good" && r.result === "ok";
  return (goodOk ? 0 : 10) + (r.email_type === "personal" ? 0 : 2) + (r.is_primary ? 0 : 1);
}

/** candidateId -> usable emails, best first. knownEmail (candidates.email) leads. */
export async function poolEmails(
  candidateIds: string[],
  knownEmails: Map<string, string | null>
): Promise<Map<string, RankedEmail[]>> {
  const rows: EmailRow[] = [];
  for (let i = 0; i < candidateIds.length; i += 100) {
    const chunk = candidateIds.slice(i, i + 100).map((x) => `"${x}"`).join(",");
    const [a, b] = await Promise.all([
      sbRest(
        `candidate_emails?candidate_id=in.(${chunk})&select=candidate_id,email:email_address,email_type,is_primary,quality,result`
      ),
      sbRest(
        `candidate_emails_v2?candidate_id=in.(${chunk})&select=candidate_id,email:email_normalized,email_type,is_primary,quality,result`
      ),
    ]);
    if (a.ok) rows.push(...((await a.json()) as EmailRow[]));
    if (b.ok) rows.push(...((await b.json()) as EmailRow[]));
  }

  const byCand = new Map<string, EmailRow[]>();
  for (const r of rows) {
    if (!str(r.email)) continue;
    if (r.quality === "bad" || r.result === "invalid") continue; // verified-dead: never surface
    const list = byCand.get(r.candidate_id) || [];
    list.push(r);
    byCand.set(r.candidate_id, list);
  }

  const out = new Map<string, RankedEmail[]>();
  for (const id of candidateIds) {
    const seenEmails = new Set<string>();
    const ranked: RankedEmail[] = [];
    const known = str(knownEmails.get(id) ?? null);
    if (known) {
      seenEmails.add(known.toLowerCase());
      ranked.push({ email: known, verified: true });
    }
    for (const r of (byCand.get(id) || []).sort((x, y) => emailScore(x) - emailScore(y))) {
      const e = str(r.email)!;
      if (seenEmails.has(e.toLowerCase())) continue;
      seenEmails.add(e.toLowerCase());
      ranked.push({ email: e, verified: r.quality === "good" && r.result === "ok" });
    }
    if (ranked.length) out.set(id, ranked);
  }
  return out;
}

async function fetchAll<T>(pathFor: (limit: number, offset: number) => string): Promise<T[]> {
  const LIMIT = 1000;
  const out: T[] = [];
  for (let offset = 0; ; offset += LIMIT) {
    const res = await sbRest(pathFor(LIMIT, offset));
    if (!res.ok) break;
    const batch = (await res.json()) as T[];
    out.push(...batch);
    if (batch.length < LIMIT) break;
  }
  return out;
}

type LinkedRole = { orgId: string; jobId: string };
type RoleInfo = {
  jobId: string; title: string; company: string | null; salary: string | null;
  location: string | null; linked: LinkedRole | null;
};

function parseLinked(v: unknown): LinkedRole | null {
  if (!v || typeof v !== "object") return null;
  const { orgId, jobId } = v as Record<string, unknown>;
  return typeof orgId === "string" && typeof jobId === "string" && orgId && jobId
    ? { orgId, jobId }
    : null;
}

async function roleIndex(orgId: string): Promise<Map<string, RoleInfo>> {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&select=id,external_id,title,company_name,salary,locations,workplace,linked_org_role`
  );
  const rows: {
    id: string; external_id: string; title: string; company_name: string | null;
    salary: string | null; locations: string[] | null; workplace: string | null;
    linked_org_role: unknown;
  }[] = res.ok ? await res.json() : [];
  const byId = new Map<string, RoleInfo>();
  for (const r of rows)
    byId.set(r.id, {
      jobId: r.external_id,
      title: r.title,
      company: str(r.company_name),
      salary: str(r.salary),
      location: [(r.locations || []).join(", ") || null, str(r.workplace)].filter(Boolean).join(" · ") || null,
      linked: parseLinked(r.linked_org_role),
    });
  return byId;
}

/** (candidateId|orgId|jobId) -> sent date, from via-TT applications in ANY
 *  org — linked roles file their applications in the client's org. */
async function sentIndex(): Promise<Map<string, string>> {
  const rows = await fetchAll<{
    organization_id: string; candidate_id: string | null; role_ids: string[] | null; created_at: string;
  }>(
    (limit, offset) =>
      `website_applications?source=eq.transformer_talent` +
      `&select=organization_id,candidate_id,role_ids,created_at&limit=${limit}&offset=${offset}`
  );
  const map = new Map<string, string>();
  for (const r of rows)
    for (const jobId of r.role_ids || [])
      if (r.candidate_id && !map.has(`${r.candidate_id}|${r.organization_id}|${jobId}`))
        map.set(`${r.candidate_id}|${r.organization_id}|${jobId}`, r.created_at);
  return map;
}

export async function listNetworkMatches(
  orgId: string,
  jobId?: string
): Promise<{ people: NetworkPerson[]; total: number }> {
  const [verdicts, roles, sent] = await Promise.all([
    fetchAll<VerdictRow>(
      (limit, offset) =>
        `match_verdicts?organization_id=eq.${orgId}` +
        `&select=candidate_id,org_role_id,source,created_at,verdict` +
        `&order=created_at.desc&limit=${limit}&offset=${offset}`
    ),
    roleIndex(orgId),
    sentIndex(),
  ]);

  // Linked roles deliver to a client org — resolve names for the UI.
  const orgNames = new Map<string, string>();
  {
    const res = await sbRest(`organizations?select=id,name`);
    for (const o of (res.ok ? await res.json() : []) as { id: string; name: string }[])
      orgNames.set(o.id, o.name);
  }

  // Newest verdict per (person, role); only scorecard-bearing rows render.
  const seen = new Set<string>();
  const byPerson = new Map<string, NetworkMatch[]>();
  const latest = new Map<string, string>();
  for (const v of verdicts) {
    const role = roles.get(v.org_role_id);
    const sc = v.verdict?.scorecard;
    if (!role || !v.candidate_id || !sc) continue;
    const key = `${v.candidate_id}|${role.jobId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = clientTag(sc);
    const list = byPerson.get(v.candidate_id) || [];
    // Sent detection follows the link: a linked role's application lives in
    // the client org under the client's job id.
    const target = role.linked ?? { orgId, jobId: role.jobId };
    list.push({
      jobId: role.jobId,
      title: role.title,
      company: role.company,
      salary: role.salary,
      location: role.location,
      tag,
      tagLabel: TAG_LABEL[tag],
      reason: clientReason(sc),
      addedAt: v.created_at,
      sentAt: sent.get(`${v.candidate_id}|${target.orgId}|${target.jobId}`) ?? null,
      sendsTo: role.linked ? orgNames.get(role.linked.orgId) || "the client" : null,
    });
    byPerson.set(v.candidate_id, list);
    if (!latest.has(v.candidate_id) || v.created_at > latest.get(v.candidate_id)!)
      latest.set(v.candidate_id, v.created_at);
  }

  // Pool details, chunked (PostgREST in-list limits).
  const ids = [...byPerson.keys()];
  const pool = new Map<string, PoolRow>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await sbRest(
      `candidates?id=in.(${chunk.map((x) => `"${x}"`).join(",")})&select=${POOL_COLS}`
    );
    for (const r of (res.ok ? await res.json() : []) as PoolRow[]) pool.set(r.id, r);
  }

  const emailMap = await poolEmails(
    ids,
    new Map(ids.map((id) => [id, pool.get(id)?.contact?.email ?? pool.get(id)?.email ?? null]))
  );

  let people: NetworkPerson[] = [];
  for (const [candidateId, matches] of byPerson) {
    const p = pool.get(candidateId);
    if (!p) continue;
    const emails = emailMap.get(candidateId) || [];
    matches.sort(
      (a, b) => TAG_RANK[a.tag] - TAG_RANK[b.tag] || b.addedAt.localeCompare(a.addedAt)
    );
    people.push({
      candidateId,
      name: p.full_name || "Candidate",
      photoUrl: str(p.profile_picture_url),
      currentTitle: str(p.current_title) || str(p.headline),
      currentCompany: str(p.current_company),
      location: str(p.location),
      linkedinUrl: str(p.linkedin_url),
      email: emails[0]?.email ?? null,
      emails,
      phone: str(p.contact?.phone) ?? str(p.phone),
      years: p.calculated_experience_years ?? p.total_experience_years ?? null,
      latestMatchAt: latest.get(candidateId) || matches[0].addedAt,
      matches,
    });
  }

  if (jobId) people = people.filter((p) => p.matches.some((m) => m.jobId === jobId));

  people.sort(
    (a, b) =>
      TAG_RANK[a.matches[0].tag] - TAG_RANK[b.matches[0].tag] ||
      b.latestMatchAt.localeCompare(a.latestMatchAt)
  );
  return { people, total: people.length };
}

export async function sendNetworkCandidate(
  orgId: string,
  candidateId: string,
  jobId: string
): Promise<{ ok: true; applicationId: string } | { ok: false; error: string }> {
  const roleRes = await sbRest(
    `org_roles?organization_id=eq.${orgId}&external_id=eq.${encodeURIComponent(jobId)}` +
      `&select=id,title,linked_org_role&limit=1`
  );
  const [role] = (roleRes.ok ? await roleRes.json() : []) as {
    id: string; title: string; linked_org_role: unknown;
  }[];
  if (!role) return { ok: false, error: "job_not_found" };

  // The wire: a linked role files the application in the CLIENT org, on the
  // client's copy of the job. Unlinked roles file into our own pipeline.
  const linked = parseLinked(role.linked_org_role);
  let target = { orgId, jobId, title: role.title, roleUuid: role.id };
  if (linked) {
    const clientRes = await sbRest(
      `org_roles?organization_id=eq.${linked.orgId}&external_id=eq.${encodeURIComponent(linked.jobId)}` +
        `&select=id,title&limit=1`
    );
    const [client] = (clientRes.ok ? await clientRes.json() : []) as { id: string; title: string }[];
    if (!client) return { ok: false, error: "linked_role_missing" };
    target = { orgId: linked.orgId, jobId: linked.jobId, title: client.title, roleUuid: client.id };
  }

  const candRes = await sbRest(`candidates?id=eq.${candidateId}&select=${POOL_COLS}&limit=1`);
  const [cand] = (candRes.ok ? await candRes.json() : []) as PoolRow[];
  if (!cand) return { ok: false, error: "candidate_not_found" };
  const bestEmail =
    (
      await poolEmails([candidateId], new Map([[candidateId, cand.contact?.email ?? cand.email]]))
    ).get(candidateId)?.[0]?.email ?? null;

  // One send per (person, target job) — pipelines never grow duplicates.
  const dupRes = await sbRest(
    `website_applications?organization_id=eq.${target.orgId}&candidate_id=eq.${candidateId}` +
      `&role_ids=cs.{"${target.jobId}"}&select=id&limit=1`
  );
  if (dupRes.ok && ((await dupRes.json()) as unknown[]).length > 0)
    return { ok: false, error: "already_sent" };

  // Richest stored profile: the newest raw Harvest full_profile from the
  // enrichment ledger — powers the drawer (photo, experience, education).
  const enrRes = await sbRest(
    `candidate_enrichments?candidate_id=eq.${candidateId}&operation=eq.full_profile` +
      `&raw_payload=not.is.null&select=raw_payload&order=created_at.desc&limit=1`
  );
  const [enr] = (enrRes.ok ? await enrRes.json() : []) as { raw_payload: Record<string, unknown> | null }[];

  // Their verdict for the MATCHED role rides along in the apply-flow
  // screening shape, so the pipeline's fit tag + review render exactly like
  // an applicant's.
  const vRes = await sbRest(
    `match_verdicts?organization_id=eq.${orgId}&candidate_id=eq.${candidateId}` +
      `&org_role_id=eq.${role.id}&select=verdict,candidate_hash,role_hash,model&order=created_at.desc&limit=1`
  );
  const [v] = (vRes.ok ? await vRes.json() : []) as {
    verdict: Record<string, unknown> | null;
    candidate_hash: string; role_hash: string; model: string | null;
  }[];

  const inserted = await sbInsert<{ id: string }>(
    "website_applications",
    {
      organization_id: target.orgId,
      name: cand.full_name || "Candidate",
      email: bestEmail || "",
      linkedin_url: cand.linkedin_url,
      linkedin_username: cand.linkedin_username,
      role_ids: [target.jobId],
      role_titles: [`${target.title} (#${target.jobId})`],
      status: "processed",
      source: "transformer_talent",
      candidate_id: candidateId,
      parsed_profile: {
        current_title: str(cand.current_title),
        current_company: str(cand.current_company),
        location: str(cand.location),
      },
      harvest_profile: enr?.raw_payload ?? null,
      screening: v?.verdict ? [{ ...v.verdict, job_id: target.jobId }] : null,
      contact:
        bestEmail || str(cand.contact?.phone) || str(cand.phone)
          ? { email: bestEmail, phone: str(cand.contact?.phone) ?? str(cand.phone) }
          : null,
    },
    true
  ).catch((e) => {
    console.error("network send insert failed", e);
    return null;
  });
  if (!inserted?.id) return { ok: false, error: "insert_failed" };

  // Cross-org send: mirror the verdict onto the client's role so their
  // pipeline (which reads org-scoped match_verdicts) shows the fit tag and
  // review immediately — not "Screening…" forever.
  if (target.orgId !== orgId && v?.verdict) {
    const existing = await sbRest(
      `match_verdicts?candidate_id=eq.${candidateId}&org_role_id=eq.${target.roleUuid}&select=id&limit=1`
    );
    if (existing.ok && ((await existing.json()) as unknown[]).length === 0) {
      await sbInsert(
        "match_verdicts",
        {
          organization_id: target.orgId,
          candidate_id: candidateId,
          org_role_id: target.roleUuid,
          candidate_hash: v.candidate_hash,
          role_hash: v.role_hash,
          verdict: { ...v.verdict, job_id: target.jobId },
          model: v.model,
          source: "referral",
        },
        false
      ).catch((e) => console.error("verdict mirror failed", e));
    }
  }
  return { ok: true, applicationId: inserted.id };
}

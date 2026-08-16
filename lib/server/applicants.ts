import { sbRest, sbRpc } from "./supabase";
import { embed } from "./matcher";

// ---------- Harvest enrichment (LinkedIn full profile; costs credits — one
// call per applicant, and failure never blocks the application) ----------

export async function harvestProfile(linkedinUrl: string): Promise<unknown | null> {
  const key = process.env.HARVEST_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.harvestapi.io/linkedin/profile?url=${encodeURIComponent(linkedinUrl)}`,
      { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(20000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    // Harvest wraps errors in a 200 ({status: 404, element: null, error: …}) —
    // only a real element is a profile.
    return data.element ?? null;
  } catch {
    return null;
  }
}

// ---------- LLM profile parse ----------

export interface ParsedProfile {
  current_title: string | null;
  current_company: string | null;
  headline: string | null;
  location: string | null;
  total_experience_years: number | null;
  previous_companies: string[];
  education_schools: string[];
  education_degrees: string[];
  education_fields: string[];
  top_skills: string[];
  profile_summary: string;
}

export async function parseProfile(
  resumeText: string,
  harvest: unknown | null
): Promise<ParsedProfile | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const source = [
    resumeText ? `RESUME:\n${resumeText.slice(0, 12000)}` : "",
    harvest ? `LINKEDIN PROFILE JSON:\n${JSON.stringify(harvest).slice(0, 12000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!source) return null;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "candidate_profile",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              current_title: { type: ["string", "null"] },
              current_company: { type: ["string", "null"] },
              headline: { type: ["string", "null"] },
              location: { type: ["string", "null"] },
              total_experience_years: { type: ["integer", "null"] },
              previous_companies: { type: "array", items: { type: "string" } },
              education_schools: { type: "array", items: { type: "string" } },
              education_degrees: { type: "array", items: { type: "string" } },
              education_fields: { type: "array", items: { type: "string" } },
              top_skills: { type: "array", items: { type: "string" } },
              profile_summary: { type: "string" },
            },
            required: [
              "current_title", "current_company", "headline", "location",
              "total_experience_years", "previous_companies", "education_schools",
              "education_degrees", "education_fields", "top_skills", "profile_summary",
            ],
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Extract a candidate profile from the resume and/or LinkedIn data. " +
            "profile_summary: dense 2-3 sentence summary of the engineer (role, seniority, " +
            "core skills, domains) suitable for semantic matching. top_skills: max 12. " +
            "previous_companies: employers other than the current one, most recent first, max 6.",
        },
        { role: "user", content: source },
      ],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  try {
    return JSON.parse(data.choices[0].message.content) as ParsedProfile;
  } catch {
    return null;
  }
}

// ---------- Candidate pool promotion ----------

export function linkedinUsername(url: string): string | null {
  const m = url.toLowerCase().match(/\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function patchCandidate(id: string, payload: Record<string, unknown>) {
  let res = await sbRest(`candidates?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
    prefer: "return=minimal",
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes("23505") && body.includes("(email)")) {
      const { email: _drop, ...rest } = payload;
      res = await sbRest(`candidates?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify(rest),
        prefer: "return=minimal",
      });
    }
    if (!res.ok) throw new Error(`candidate patch failed: ${await res.text().catch(() => "")}`);
  }
}

export async function promoteToCandidatePool(args: {
  name: string;
  email: string;
  linkedinUrl: string | null;
  resumeText: string | null;
  parsed: ParsedProfile | null;
  allSkills?: string[]; // full uncapped skill list (Harvest), preferred over parsed top 12
}): Promise<{ candidateId: string | null; vector: number[] | null }> {
  const { name, email, linkedinUrl, resumeText, parsed, allSkills } = args;
  const username = linkedinUrl ? linkedinUsername(linkedinUrl) : null;
  if (!username) return { candidateId: null, vector: null };

  const summaryText =
    parsed?.profile_summary ||
    [parsed?.current_title, parsed?.current_company && `at ${parsed.current_company}`]
      .filter(Boolean)
      .join(" ") ||
    resumeText?.slice(0, 2000) ||
    "";
  const vector = summaryText ? await embed(summaryText).catch(() => null) : null;

  const fields: Record<string, unknown> = {
    source: "website_applicant",
    status: "applicant",
    email,
    ...(resumeText ? { resume_text: resumeText.slice(0, 50000) } : {}),
    ...(parsed?.current_title ? { current_title: parsed.current_title } : {}),
    ...(parsed?.current_company ? { current_company: parsed.current_company } : {}),
    ...(parsed?.headline ? { headline: parsed.headline } : {}),
    ...(parsed?.location ? { location: parsed.location } : {}),
    ...(parsed?.total_experience_years
      ? { total_experience_years: parsed.total_experience_years }
      : {}),
    ...(parsed?.previous_companies?.length
      ? { previous_companies: parsed.previous_companies }
      : {}),
    ...(parsed?.education_schools?.length
      ? {
          education_schools: parsed.education_schools,
          education_degrees: parsed.education_degrees,
          education_fields: parsed.education_fields,
        }
      : {}),
    ...(allSkills?.length
      ? { top_skills: allSkills }
      : parsed?.top_skills?.length
        ? { top_skills: parsed.top_skills }
        : {}),
    ...(vector ? { matching_embedding: JSON.stringify(vector), embedding_type: "website_applicant" } : {}),
  };

  const existing = await sbRest(
    `candidates?linkedin_username=eq.${encodeURIComponent(username)}&select=id,matching_embedding`
  );
  const rows = existing.ok ? await existing.json() : [];
  if (rows.length > 0) {
    // Merge into the enriched profile; keep its richer embedding if ours is thin.
    const keep = { ...fields };
    if (rows[0].matching_embedding && !resumeText) delete keep.matching_embedding;
    await patchCandidate(rows[0].id, keep);
    return { candidateId: rows[0].id, vector };
  }

  const [first, ...restName] = name.split(/\s+/);
  const insert = await sbRest("candidates", {
    method: "POST",
    body: JSON.stringify({
      full_name: name,
      first_name: first,
      last_name: restName.join(" ") || null,
      linkedin_url: linkedinUrl,
      linkedin_username: username,
      ...fields,
    }),
    prefer: "return=representation",
  });
  if (!insert.ok) {
    console.error("candidate insert failed", await insert.text());
    return { candidateId: null, vector };
  }
  const [row] = await insert.json();
  return { candidateId: row.id, vector };
}

// ---------- Reverse role matching (hybrid: embedding ∪ keyword) ----------

export interface RoleMatch {
  job_id: string;
  title: string;
  similarity: number;
  keyword_hits: number;
}

export async function matchRolesForApplicant(
  vector: number[],
  skills: string[] = []
): Promise<RoleMatch[]> {
  const [vec, kw] = await Promise.all([
    sbRpc<{ job_id: string; title: string; similarity: number }[]>("match_site_roles", {
      query_embedding: vector,
      match_count: 5,
    }).catch(() => []),
    skills.length
      ? sbRpc<{ job_id: string; title: string; keyword_hits: number }[]>("match_roles_keyword", {
          skills: skills.slice(0, 40),
          match_count: 5,
        }).catch(() => [])
      : Promise.resolve([]),
  ]);
  // Union: exact stack hits make the shortlist even when the embedding misses.
  const merged = new Map<string, RoleMatch>();
  for (const v of vec) merged.set(v.job_id, { ...v, keyword_hits: 0 });
  for (const k of kw) {
    const existing = merged.get(k.job_id);
    if (existing) existing.keyword_hits = k.keyword_hits;
    else merged.set(k.job_id, { job_id: k.job_id, title: k.title, similarity: 0, keyword_hits: k.keyword_hits });
  }
  return [...merged.values()];
}

// ---------- Reply-ops Airtable mirror (create-only, deduped) ----------

export async function mirrorToAirtable(args: {
  name: string;
  email: string;
  linkedinUrl: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  roleTitles: string[];
}): Promise<void> {
  const token = process.env.AIRTABLE_API_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!token || !base) return;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    // Dedupe by email or LinkedIn URL — never touch existing records.
    const formula = encodeURIComponent(
      `OR({Primary Email}="${args.email}",{LinkedIn URL}="${args.linkedinUrl || ""}")`
    );
    const check = await fetch(
      `https://api.airtable.com/v0/${base}/Candidates?maxRecords=1&filterByFormula=${formula}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (check.ok && (await check.json()).records?.length > 0) return;

    await fetch(`https://api.airtable.com/v0/${base}/Candidates`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        records: [
          {
            fields: {
              "Full Name": args.name,
              "Primary Email": args.email,
              ...(args.linkedinUrl ? { "LinkedIn URL": args.linkedinUrl } : {}),
              ...(args.currentTitle ? { "Current Title": args.currentTitle } : {}),
              ...(args.currentCompany ? { "Current Company": args.currentCompany } : {}),
              Owner: "Website",
              Notes: `Website applicant — applied to: ${args.roleTitles.join("; ") || "general"}`,
            },
          },
        ],
      }),
    });
  } catch {
    // Mirroring must never fail an application.
  }
}

// Short-lived signed URL for a private resume — Airtable fetches it once and
// keeps its own copy, so the bucket stays private.
async function signResumeUrl(resumePath: string): Promise<string | null> {
  const key = process.env.SUPABASE_STORAGE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.SUPABASE_URL;
  if (!key || !url) return null;
  try {
    const res = await fetch(`${url}/storage/v1/object/sign/resumes/${resumePath}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const { signedURL } = (await res.json()) as { signedURL?: string };
    return signedURL ? `${url}/storage/v1${signedURL}` : null;
  } catch {
    return null;
  }
}

// Look up Airtable Roles-record ids for a set of job ids. Best-effort — a
// role not yet synced just links later via the nightly pass.
async function airtableRoleRecords(jobIds: string[]): Promise<Record<string, string>> {
  const token = process.env.AIRTABLE_API_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID;
  const ids = [...new Set(jobIds)].filter(Boolean).slice(0, 20);
  if (!token || !base || !ids.length) return {};
  try {
    const formula = encodeURIComponent(`OR(${ids.map((id) => `{Job ID}="${id}"`).join(",")})`);
    const res = await fetch(
      `https://api.airtable.com/v0/${base}/Roles?filterByFormula=${formula}&fields%5B%5D=Job%20ID`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return {};
    const out: Record<string, string> = {};
    for (const rec of (await res.json()).records || []) out[rec.fields["Job ID"]] = rec.id;
    return out;
  } catch {
    return {};
  }
}

// Review table: EVERY application gets a row here — including repeat
// applicants, who leave no trace in the create-only Candidates mirror.
export async function mirrorApplicationToAirtable(args: {
  applicationId: string;
  name: string;
  email: string;
  linkedinUrl: string | null;
  visa: string | null;
  roleTitles: string[];
  matchedTitles: string[];
  resumePath?: string | null;
  appliedRoleIds?: string[];
  matchedRoleIds?: string[];
  applicationType?: "Applied" | "Speculative";
  screenedSummary?: string; // e.g. "5 screened (1 qualified)"
  preferredLocations?: string[];
  applicationFit?: string; // rendered scorecards for the APPLIED roles
}): Promise<void> {
  const token = process.env.AIRTABLE_API_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!token || !base) return;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    // Link to the Candidates record when one exists.
    let candidateRecordId: string | null = null;
    const formula = encodeURIComponent(
      `OR({Primary Email}="${args.email}",{LinkedIn URL}="${args.linkedinUrl || ""}")`
    );
    const found = await fetch(
      `https://api.airtable.com/v0/${base}/Candidates?maxRecords=1&filterByFormula=${formula}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (found.ok) candidateRecordId = (await found.json()).records?.[0]?.id ?? null;

    const resumeUrl = args.resumePath ? await signResumeUrl(args.resumePath) : null;
    const resumeFilename = args.resumePath
      ? args.resumePath.split("/").pop()!.replace(/^[0-9a-f-]{37}/, "")
      : null;
    const roleRecs = await airtableRoleRecords([
      ...(args.appliedRoleIds || []),
      ...(args.matchedRoleIds || []),
    ]);
    const linkTo = (ids?: string[]) =>
      (ids || []).map((id) => roleRecs[id]).filter(Boolean);
    const appliedLinks = linkTo(args.appliedRoleIds);
    const matchedLinks = linkTo(args.matchedRoleIds).filter((id) => !appliedLinks.includes(id));

    await fetch(`https://api.airtable.com/v0/${base}/Website%20Applications`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        records: [
          {
            fields: {
              Name: args.name,
              Email: args.email,
              ...(args.linkedinUrl ? { LinkedIn: args.linkedinUrl } : {}),
              "Roles Applied": args.roleTitles.join("\n") || "Speculative — resume drop",
              ...(args.applicationType ? { "Application Type": args.applicationType } : {}),
              ...(args.screenedSummary ? { Screened: args.screenedSummary } : {}),
              ...(args.preferredLocations?.length
                ? { "Preferred Locations": args.preferredLocations.join(", ") }
                : {}),
              ...(args.applicationFit ? { "Application Fit": args.applicationFit } : {}),
              "Matched Roles": args.matchedTitles.join("\n"),
              ...(args.visa ? { Visa: args.visa } : {}),
              "Applied At": new Date().toISOString(),
              "Application ID": args.applicationId,
              ...(resumeUrl ? { Resume: [{ url: resumeUrl, filename: resumeFilename || "resume.pdf" }] } : {}),
              ...(appliedLinks.length ? { "Applied Roles": appliedLinks } : {}),
              ...(matchedLinks.length ? { "Matched Roles Linked": matchedLinks } : {}),
              ...(candidateRecordId ? { Candidate: [candidateRecordId] } : {}),
            },
          },
        ],
      }),
    });
  } catch {
    // Mirroring must never fail an application.
  }
}

// add-role updates the review row so Airtable matches Supabase.
export async function updateAirtableApplicationRoles(
  applicationId: string,
  roleTitles: string[]
): Promise<void> {
  const token = process.env.AIRTABLE_API_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!token || !base) return;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    const formula = encodeURIComponent(`{Application ID}="${applicationId}"`);
    const found = await fetch(
      `https://api.airtable.com/v0/${base}/Website%20Applications?maxRecords=1&filterByFormula=${formula}`,
      { headers, signal: AbortSignal.timeout(10000) }
    );
    if (!found.ok) return;
    const rec = (await found.json()).records?.[0];
    if (!rec) return;
    await fetch(`https://api.airtable.com/v0/${base}/Website%20Applications/${rec.id}`, {
      method: "PATCH",
      headers,
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ fields: { "Roles Applied": roleTitles.join("\n") } }),
    });
  } catch {
    // Best-effort.
  }
}

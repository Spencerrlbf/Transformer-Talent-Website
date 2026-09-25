import { sbRest, sbRpc } from "./supabase";
import { embed } from "./matcher";
import { normalEmail, poolPersonHasEmail } from "./pool-emails";

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
  /** Contact details as written on the resume (added later; older rows lack them). */
  phone?: string | null;
  email?: string | null;
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
              phone: { type: ["string", "null"] },
              email: { type: ["string", "null"] },
            },
            required: [
              "current_title", "current_company", "headline", "location",
              "total_experience_years", "previous_companies", "education_schools",
              "education_degrees", "education_fields", "top_skills", "profile_summary",
              "phone", "email",
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
            "previous_companies: employers other than the current one, most recent first, max 6. " +
            "phone / email: the candidate's own contact details exactly as written in the RESUME " +
            "(not a referee's, not a company switchboard); null when the resume shows none.",
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

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The profile name after the first "/in/" in any string. Loose on purpose
 *  (older rows were keyed with it); the public forms use canonicalLinkedin. */
export function linkedinUsername(url: string): string | null {
  const m = url.toLowerCase().match(/\/in\/([^/?#]+)/);
  // A malformed escape ("%E0%A4%A") keeps the name as typed instead of throwing.
  return m ? safeDecode(m[1]) : null;
}

// Letters and digits in any script, plus the - _ . LinkedIn's own profile
// names use. Anything else (spaces, slashes, quotes, a stray %) is not a
// profile name someone copied from their browser.
const PROFILE_NAME = /^[\p{L}\p{M}\p{N}_.-]+$/u;

// LinkedIn's member-id links (/in/ACoAAB..., what search results and Sales
// Navigator hand out) are case-sensitive, unlike profile names: lowercased,
// they point nowhere. Their address keeps the case typed; the key is still
// the lowercased name, like every other.
const MEMBER_ID = /^AC[ow]AA[A-Za-z0-9_-]{10,}$/;

/** The one form of a LinkedIn profile address this site keeps: the profile
 *  name (decoded, lowercased) and the address rebuilt from it. Null unless
 *  the address really is linkedin.com/in/<name>: the host must be
 *  linkedin.com or a subdomain of it (www, uk, de, m...), and the path must
 *  start with /in/. A "/in/" in a query string or on another site is not a
 *  profile. The key stored with an application and the profile looked up for
 *  it both come from this one parse, so they can never be two people.
 *  (LinkedIn can still answer an address with another profile, e.g. an old
 *  name that now redirects: the pipeline checks what comes back.) */
export function canonicalLinkedin(raw: string): { username: string; url: string } | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  let u: URL;
  try {
    u = new URL(scheme ? s : `https://${s}`);
  } catch {
    return null;
  }
  // "linkedin.com@elsewhere" and "mailto:x@linkedin.com/in/..." tricks.
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const m = u.pathname.match(/^\/in\/([^/]+)/i);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const username = slug.toLowerCase();
  if (!PROFILE_NAME.test(username) || /^\.+$/.test(username) || [...username].length > 200) return null;
  const path = MEMBER_ID.test(slug) ? slug : username;
  return { username, url: `https://www.linkedin.com/in/${encodeURIComponent(path)}` };
}

/** The profile name a Harvest profile says is its own: its publicIdentifier,
 *  else the name in its linkedinUrl or url, decoded and lowercased. Null
 *  when it names none or can't be read; never throws. */
export function harvestIdentity(payload: unknown): string | null {
  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const h = payload as Record<string, unknown>;
    const pid = typeof h.publicIdentifier === "string" ? h.publicIdentifier.trim() : "";
    const own = pid
      ? safeDecode(pid).toLowerCase()
      : [h.linkedinUrl, h.url]
          .map((v) => (typeof v === "string" ? canonicalLinkedin(v)?.username : null))
          .find(Boolean) || "";
    // One spelling for letters that can be written two ways (ö as one
    // character or as o plus a mark), so the same name always compares equal.
    return own ? own.normalize("NFC") : null;
  } catch {
    return null;
  }
}

/** Whether a Harvest profile is the profile of `username` (see
 *  harvestIdentity). Anything unreadable is a no, never an error. */
export function harvestIsFor(payload: unknown, username: string | null): boolean {
  try {
    const own = harvestIdentity(payload);
    return Boolean(own && username) && own === safeDecode(username!).toLowerCase().normalize("NFC");
  } catch {
    return false;
  }
}

/** The spellings a pool record may carry for this profile name. Every
 *  writer (linkedinUsername above, the Airtable and directory syncs)
 *  lowercased the address before decoding it, so a letter typed as an
 *  escape (Ö as %C3%96) kept its capital while everything else was
 *  lowercased. So: the name itself, plus the forms with those letters
 *  capitalized (up to four). */
export function usernameForms(username: string): string[] {
  const chars = [...username];
  const spots = chars
    .map((c, i) => (c.codePointAt(0)! > 0x7f && c.toUpperCase() !== c && [...c.toUpperCase()].length === 1 ? i : -1))
    .filter((i) => i >= 0)
    .slice(0, 4);
  const forms = new Set<string>();
  for (let mask = 0; mask < 1 << spots.length; mask++) {
    forms.add(
      chars
        .map((c, i) => {
          const k = spots.indexOf(i);
          return k >= 0 && mask & (1 << k) ? c.toUpperCase() : c;
        })
        .join("")
    );
  }
  return [...forms];
}

/** The same submitter on a public form: the same email (any case) AND the
 *  same LinkedIn profile. Either one alone can be typed by anyone. */
export function sameSubmitter(
  row: { email?: string | null; linkedin_username?: string | null },
  email: string,
  username: string
): boolean {
  const e = normalEmail(email);
  return Boolean(e && username) && normalEmail(row.email) === e && row.linkedin_username === username;
}

/** This org's rows from the last 14 days sent by the same submitter (see
 *  sameSubmitter), newest first, with the columns asked for. */
export async function recentSameSubmitter<T extends { id: string }>(
  orgId: string | null,
  email: string,
  username: string,
  cols: string
): Promise<T[]> {
  if (!orgId || !username) return [];
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const res = await sbRest(
    `website_applications?organization_id=eq.${orgId}&linkedin_username=eq.${encodeURIComponent(username)}` +
      `&created_at=gte.${since}&select=email,linkedin_username,${cols}&order=created_at.desc&limit=100`
  );
  const rows = res.ok ? ((await res.json()) as (T & { email: string | null; linkedin_username: string | null })[]) : [];
  return rows.filter((r) => sameSubmitter(r, email, username));
}

const isEmpty = (v: unknown): boolean =>
  v == null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every(isEmpty));

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

/** The vector an applicant is matched to roles with: their profile summary,
 *  else title at company, else the start of their resume. */
export async function applicantVector(
  parsed: ParsedProfile | null,
  resumeText: string | null
): Promise<number[] | null> {
  const summaryText =
    parsed?.profile_summary ||
    [parsed?.current_title, parsed?.current_company && `at ${parsed.current_company}`]
      .filter(Boolean)
      .join(" ") ||
    resumeText?.slice(0, 2000) ||
    "";
  return summaryText ? await embed(summaryText).catch(() => null) : null;
}

/** The person key a client company's applicant is judged under. They never
 *  enter Transformer Talent's pool, so their verdicts hang off the company's
 *  own first application from this person: the same person applying twice
 *  keeps one set of verdicts and confirmed rows, and no two companies ever
 *  share a key. "This person" means the same LinkedIn profile AND the same
 *  email, since either alone can be typed by a stranger. (People TT sent
 *  keep TT's pool id and are skipped.) */
export async function tenantPersonId(
  orgId: string,
  username: string | null,
  email: string,
  submissionId: string
): Promise<string> {
  if (!username) return submissionId;
  const res = await sbRest(
    `website_applications?organization_id=eq.${orgId}&linkedin_username=eq.${encodeURIComponent(username)}` +
      `&or=(source.is.null,source.neq.transformer_talent)&select=id,email,linkedin_username&order=created_at.asc&limit=100`
  );
  const rows = res.ok
    ? ((await res.json()) as { id: string; email: string | null; linkedin_username: string | null }[])
    : [];
  return rows.find((r) => sameSubmitter(r, email, username))?.id ?? submissionId;
}

/** A "hear from me later" ask on a pool record. Fills only what the record
 *  lacks (the date, what to come back with, visa): what TT already has for
 *  the person is never replaced from a public form. */
export async function fillPoolFollowUp(
  candidateId: string,
  ask: { followUpAt: string; rolePreferences: Record<string, unknown>; visa: string | null }
): Promise<void> {
  const res = await sbRest(`candidates?id=eq.${candidateId}&select=follow_up_at,role_preferences,visa_status`);
  const [row] = res.ok
    ? ((await res.json()) as { follow_up_at: unknown; role_preferences: unknown; visa_status: unknown }[])
    : [];
  if (!row) return;
  const patch: Record<string, unknown> = {};
  if (isEmpty(row.follow_up_at)) patch.follow_up_at = ask.followUpAt;
  if (isEmpty(row.role_preferences)) patch.role_preferences = ask.rolePreferences;
  if (ask.visa && isEmpty(row.visa_status)) patch.visa_status = ask.visa;
  if (!Object.keys(patch).length) return;
  await sbRest(`candidates?id=eq.${candidateId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
    prefer: "return=minimal",
  });
}

/** Where a TT applicant's verdicts and screening hang, and what the
 *  submission may write to Transformer Talent's pool. */
export type PoolLink = {
  /** A pool id, or the submission's own id when it stands alone. */
  candidateId: string | null;
  vector: number[] | null;
  /** The submission matched a pool person it could not prove to be: it is
   *  keyed by itself and writes nothing to that person. */
  standalone: boolean;
  /** The person is new, or this submission gave them their first resume:
   *  its resume and summary may become the person's embeddings. */
  resumeIsTheirs: boolean;
};

export async function promoteToCandidatePool(args: {
  submissionId: string;
  name: string;
  email: string;
  linkedinUrl: string | null;
  resumeText: string | null;
  parsed: ParsedProfile | null;
  allSkills?: string[]; // full uncapped skill list (Harvest), preferred over parsed top 12
}): Promise<PoolLink> {
  const { submissionId, name, email, linkedinUrl, resumeText, parsed, allSkills } = args;
  const canon = linkedinUrl ? canonicalLinkedin(linkedinUrl) : null;
  if (!canon) return { candidateId: null, vector: null, standalone: false, resumeIsTheirs: false };
  const username = canon.username;

  const vector = await applicantVector(parsed, resumeText);

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

  const cols = Object.keys(fields).filter((k) => k !== "matching_embedding" && k !== "embedding_type");
  const standalone: PoolLink = { candidateId: submissionId, vector, standalone: true, resumeIsTheirs: false };
  const forms = usernameForms(username);
  const existing = await sbRest(
    `candidates?linkedin_username=${
      forms.length > 1
        ? `in.(${forms.map((f) => encodeURIComponent(`"${f}"`)).join(",")})`
        : `eq.${encodeURIComponent(username)}`
    }&select=id,matching_embedding,contact,${cols.join(",")}`
  );
  // A failed read is not "nobody": creating a record then could copy a
  // person TT already has under a stranger's email.
  if (!existing.ok) return standalone;
  const rows = (await existing.json()) as Record<string, unknown>[];
  if (rows.length > 0) {
    // A public form can't prove who is typing: anyone can type someone
    // else's LinkedIn. The submission joins this person only when its email
    // is one TT already has for them. Otherwise it stands on its own, keyed
    // by the application itself like a client company's applicant, and
    // writes nothing to the person.
    let row: Record<string, unknown> | undefined;
    for (const r of rows) {
      if (await poolPersonHasEmail(r.id as string, email, r)) {
        row = r;
        break;
      }
    }
    if (!row) return standalone;
    // Even then an existing record only gains what it lacks; everything the
    // person typed stays on their application.
    const keep: Record<string, unknown> = {};
    for (const k of cols) if (isEmpty(row[k])) keep[k] = fields[k];
    if (!row.matching_embedding && fields.matching_embedding) {
      keep.matching_embedding = fields.matching_embedding;
      keep.embedding_type = fields.embedding_type;
    }
    if (Object.keys(keep).length) await patchCandidate(row.id as string, keep);
    return { candidateId: row.id as string, vector, standalone: false, resumeIsTheirs: "resume_text" in keep };
  }

  const [first, ...restName] = name.split(/\s+/);
  const insert = await sbRest("candidates", {
    method: "POST",
    body: JSON.stringify({
      full_name: name,
      first_name: first,
      last_name: restName.join(" ") || null,
      linkedin_url: canon.url,
      linkedin_username: username,
      ...fields,
    }),
    prefer: "return=representation",
  });
  if (!insert.ok) {
    console.error("candidate insert failed", await insert.text());
    return { candidateId: null, vector, standalone: false, resumeIsTheirs: false };
  }
  const [row] = await insert.json();
  return { candidateId: row.id, vector, standalone: false, resumeIsTheirs: true };
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
  skills: string[] = [],
  // Site org id: the keyword channel scans org_roles across ALL orgs, so it
  // must be scoped or a site applicant can surface another tenant's role.
  organizationId: string | null = null
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
          org_filter: organizationId,
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

/** Typed text as a string inside an Airtable formula. The email check lets a
 *  quote through, and an unescaped one would rewrite the formula. */
export const formulaText = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

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
      `OR({Primary Email}=${formulaText(args.email)},{LinkedIn URL}=${formulaText(args.linkedinUrl || "")})`
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
// keeps its own copy, so the bucket stays private. Also used by the employer
// dashboard's candidate view.
export async function signResumeUrl(resumePath: string): Promise<string | null> {
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
  applicationType?: "Applied" | "Speculative" | "Referral";
  screenedSummary?: string; // e.g. "5 screened (1 qualified)"
  preferredLocations?: string[];
  applicationFit?: string; // rendered scorecards for the APPLIED roles
  /** The entry is tied to a TT pool person (new, or matched by a known
   *  email). Otherwise the row is kept but linked to no Candidates record:
   *  the LinkedIn typed would link a stranger's entry to the real person. */
  linkCandidate: boolean;
}): Promise<void> {
  const token = process.env.AIRTABLE_API_TOKEN;
  const base = process.env.AIRTABLE_BASE_ID;
  if (!token || !base) return;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  try {
    // Link to the Candidates record when one exists.
    let candidateRecordId: string | null = null;
    if (args.linkCandidate) {
      const formula = encodeURIComponent(
        `OR({Primary Email}=${formulaText(args.email)},{LinkedIn URL}=${formulaText(args.linkedinUrl || "")})`
      );
      const found = await fetch(
        `https://api.airtable.com/v0/${base}/Candidates?maxRecords=1&filterByFormula=${formula}`,
        { headers, signal: AbortSignal.timeout(10000) }
      );
      if (found.ok) candidateRecordId = (await found.json()).records?.[0]?.id ?? null;
    }

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
        // Lets Airtable create new select options (e.g. Application Type:
        // Referral) instead of silently rejecting the record.
        typecast: true,
      }),
    });
  } catch {
    // Mirroring must never fail an application.
  }
}

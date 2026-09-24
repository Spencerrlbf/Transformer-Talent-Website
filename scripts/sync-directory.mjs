#!/usr/bin/env node
// Nightly sync: the engaged directory (the communications Supabase project:
// board.candidates plus the Harvest enrichment under comms) → the website's
// candidates pool. Read-only against the directory. Engaged people get
// source='directory', which the matcher badges and boosts the way the old
// Airtable sync's rows were.
//
//   DRY_RUN=1            read everything, write nothing, print what would change
//   SINCE=2026-09-22     only contacts changed since then (the nightly run: two days)
//   LIMIT=500            stop after this many contacts (a bounded test)
//   COMMS_WORKSPACE=...  the directory workspace by name, when there is more than one
//
// Needs COMMS_DATABASE_URL (the directory), SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// (the website) and OPENAI_API_KEY (embeddings for new or changed people; not for a
// dry run). The workflow installs `pg` before running this.
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const clean = (s) => (typeof s === "string" ? s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim() || null : null);
const list = (v) => {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? x.name || x.title || "" : "")).map((s) => clean(s)).filter(Boolean);
  if (typeof v === "string") return v.split(/,|\n|;/).map((s) => clean(s)).filter(Boolean);
  return [];
};

export function normalizeLinkedin(url) {
  if (!url || typeof url !== "string") return null;
  let u = url.trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!u) return null;
  if (!/^https?:\/\//.test(u)) u = u.includes("linkedin.com") ? `https://${u}` : `https://www.linkedin.com/in/${u.replace(/^\/?in\//, "")}`;
  return u.replace(/^http:/, "https:").replace("://linkedin.com", "://www.linkedin.com");
}
export const usernameOf = (url) => {
  const m = url && url.match(/\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

/** Harvest experience rows → the position shape the pool already uses. */
export function experienceRows(exps) {
  return [...(exps || [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((e) => ({
      title: clean(e.title),
      company: clean(e.company_name),
      duration: clean(e.duration_text),
      location: clean(e.location),
      is_current: e.is_current === true,
      start_date: e.start_year ? { year: e.start_year, month: e.start_month ? MONTHS[e.start_month] : null } : null,
      end_date: e.end_year ? { year: e.end_year, month: e.end_month ? MONTHS[e.end_month] : null } : null,
      description: clean(e.description),
      company_linkedin_url: clean(e.company_linkedin_url),
    }));
}

/** Harvest education rows → the "School - Degree in Field" lines the pool stores. */
export function educationLines(edus) {
  const rows = [...(edus || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const lines = rows.map((e) => {
    const school = clean(e.school_name);
    const degree = clean(e.degree);
    const field = clean(e.field_of_study);
    if (!school) return null;
    return degree && field ? `${school} - ${degree} in ${field}` : degree ? `${school} - ${degree}` : field ? `${school} - ${field}` : school;
  }).filter(Boolean);
  return {
    education: lines.length ? lines.join("\n") : null,
    education_schools: rows.map((e) => clean(e.school_name)).filter(Boolean),
    education_degrees: rows.map((e) => clean(e.degree)).filter(Boolean),
    education_fields: rows.map((e) => clean(e.field_of_study)).filter(Boolean),
  };
}

/** One directory contact (a board.candidates row, its Harvest profile,
 *  experiences and educations) → the website's candidates columns. */
export function mapContact(row, harvest, exps, edus) {
  const linkedin = normalizeLinkedin(harvest?.linkedin_url || row.linkedin_url);
  const positions = experienceRows(exps);
  const edu = edus?.length ? educationLines(edus) : { education: clean(row.education), education_schools: list(row.school), education_degrees: [], education_fields: [] };
  const skills = harvest?.skills ? list(harvest.skills) : list(row.skills);
  const dnc = row.do_not_contact === true || row.status === "Do Not Contact";
  const years = harvest?.years_experience != null ? Math.round(Number(harvest.years_experience)) : null;
  return {
    directory_contact_id: row.contact_id,
    full_name: clean(row.name) || [clean(row.first_name), clean(row.last_name)].filter(Boolean).join(" ") || "Unknown",
    first_name: clean(row.first_name) || clean(harvest?.first_name),
    last_name: clean(row.last_name) || clean(harvest?.last_name),
    current_title: clean(harvest?.current_title) || clean(row.title),
    current_company: clean(harvest?.current_company) || clean(row.company),
    linkedin_url: linkedin,
    linkedin_username: usernameOf(linkedin),
    email: clean(row.primary_email),
    location: clean(harvest?.location_text) || clean(row.location) || clean(row.metro),
    headline: clean(harvest?.headline) || clean(row.linkedin_headline) || clean(row.one_liner),
    profile_summary: clean(harvest?.about),
    education: edu.education,
    education_schools: edu.education_schools,
    education_degrees: edu.education_degrees,
    education_fields: edu.education_fields,
    top_skills: skills.slice(0, 50),
    all_skills_text: skills.length ? skills.join(", ") : null,
    work_experience: positions.length ? positions : null,
    calculated_experience_years: Number.isFinite(years) ? years : null,
    status: dnc ? "Do Not Contact" : clean(row.status) || "engaged",
    follow_up_at: row.follow_up_date ? String(row.follow_up_date).slice(0, 10) : null,
    source: "directory",
  };
}

/** What the matcher embeds for an engaged person. */
export function embeddingText(m) {
  const positions = (m.work_experience || []).slice(0, 6).map((p) => [p.title, p.company && `at ${p.company}`].filter(Boolean).join(" "));
  return [
    [m.current_title, m.current_company && `at ${m.current_company}`].filter(Boolean).join(" "),
    m.headline,
    m.location,
    m.profile_summary && m.profile_summary.slice(0, 600),
    positions.join("; "),
    m.education,
    (m.top_skills || []).slice(0, 25).join(", "),
    "actively engaged software candidate",
  ].filter(Boolean).join(". ").slice(0, 8000);
}

/** What an existing website row gets: the directory's values, never a blank
 *  over data the pool already holds. Status, source, the link and the
 *  contact details always come across. */
export function patchFor(m) {
  const always = new Set(["directory_contact_id", "source", "status", "email", "linkedin_url", "linkedin_username", "follow_up_at"]);
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    const empty = v === null || v === undefined || (Array.isArray(v) && v.length === 0);
    if (!empty || always.has(k)) out[k] = v;
  }
  return out;
}

/** Embed when the row has no embedding, or only the old Airtable one-liner
 *  and the directory now has real experience for the person. */
export const needsEmbedding = (prev, m) => !prev.matching_embedding || (prev.embedding_type === "airtable_sync" && !!m.work_experience);

export const syncHash = (m, fetchedAt) => crypto.createHash("sha256").update(JSON.stringify([m, fetchedAt || null, "v1"])).digest("hex").slice(0, 32);

const recordIds = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : []).map((s) => String(s).trim()).filter((s) => /^rec[A-Za-z0-9]{14}$/.test(s));
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const inList = (values) => encodeURIComponent(`(${values.map((v) => `"${String(v).replace(/"/g, "")}"`).join(",")})`);

async function main() {
  const { COMMS_DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY } = process.env;
  const DRY_RUN = !!process.env.DRY_RUN;
  const LIMIT = Math.max(0, parseInt(process.env.LIMIT || "0", 10) || 0);
  const SINCE = (process.env.SINCE || "").trim() || null;
  for (const [k, v] of Object.entries({ COMMS_DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ...(DRY_RUN ? {} : { OPENAI_API_KEY }) })) {
    if (!v) throw new Error(`Missing env: ${k}`);
  }
  const { default: pg } = await import("pg");
  // The string may name a CA file on the machine it was copied from; the
  // runner has no such file, so TLS is on without that check.
  const dsn = new URL(COMMS_DATABASE_URL);
  for (const k of ["sslrootcert", "sslcert", "sslkey", "sslmode"]) dsn.searchParams.delete(k);
  const db = new pg.Client({ connectionString: dsn.toString(), ssl: { rejectUnauthorized: false }, application_name: "tt-website-directory-sync", statement_timeout: 120_000 });
  await db.connect();
  await db.query("set default_transaction_read_only = on");

  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
  async function sb(path, init = {}) {
    const url = `${SUPABASE_URL.trim().replace(/\/+$/, "")}/rest/v1/${path}`;
    let res;
    try {
      res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    } catch (err) {
      throw new Error(`${init.method || "GET"} ${path.split("?")[0]} (url ${url.length} chars, body ${init.body ? init.body.length : 0} chars): ${err instanceof Error ? err.cause?.message || err.message : err}`);
    }
    if (!res.ok) throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // The directory: which workspace, and what the view offers.
  const workspaces = (await db.query("select w.id, w.name, count(c.id)::int as contacts from comms.workspaces w left join comms.contacts c on c.workspace_id = w.id group by w.id, w.name order by contacts desc")).rows;
  console.log("workspaces:", workspaces.map((w) => `${w.name} (${w.contacts})`).join(", "));
  const wanted = (process.env.COMMS_WORKSPACE || "").trim();
  const ws = wanted ? workspaces.find((w) => w.name === wanted) : workspaces.length === 1 ? workspaces[0] : null;
  if (!ws) throw new Error(wanted ? `workspace "${wanted}" not found` : "more than one workspace: set COMMS_WORKSPACE to the one to sync");
  const cols = (await db.query("select column_name from information_schema.columns where table_schema = 'board' and table_name = 'candidates' order by ordinal_position")).rows.map((r) => r.column_name);
  console.log(`board.candidates columns: ${cols.join(", ")}`);
  const coverage = (await db.query(`select
      (select count(*) from board.candidates v join comms.contacts c on c.id = v.contact_id where c.workspace_id = $1) as contacts,
      (select count(*) from board.candidates v join comms.contacts c on c.id = v.contact_id where c.workspace_id = $1 and v.do_not_contact) as do_not_contact,
      (select count(*) from comms.harvest_profiles where workspace_id = $1) as harvest_profiles,
      (select count(distinct contact_id) from comms.contact_experiences where workspace_id = $1 and superseded_at is null) as with_experiences,
      (select count(distinct contact_id) from comms.contact_educations where workspace_id = $1 and superseded_at is null) as with_educations,
      (select count(*) from board.candidates v join comms.contacts c on c.id = v.contact_id where c.workspace_id = $1 and coalesce(v.linkedin_url, '') <> '') as with_linkedin,
      (select count(*) from board.candidates v join comms.contacts c on c.id = v.contact_id where c.workspace_id = $1 and coalesce(v.linkedin_url, '') <> '' and not exists (select 1 from comms.harvest_profiles h where h.contact_id = v.contact_id)) as linkedin_no_harvest,
      (select count(*) from board.candidates v join comms.contacts c on c.id = v.contact_id where c.workspace_id = $1 and coalesce(v.linkedin_url, '') <> '' and not exists (select 1 from comms.harvest_profiles h where h.contact_id = v.contact_id) and coalesce(v.primary_email, '') <> '') as linkedin_no_harvest_with_email`, [ws.id])).rows[0];
  console.log(`directory "${ws.name}": ${coverage.contacts} contacts (${coverage.do_not_contact} do not contact), Harvest profiles ${coverage.harvest_profiles}, with experiences ${coverage.with_experiences}, with educations ${coverage.with_educations}; with a LinkedIn URL ${coverage.with_linkedin}, of which without Harvest ${coverage.linkedin_no_harvest} (${coverage.linkedin_no_harvest_with_email} with an email)${SINCE ? `; syncing those changed since ${SINCE}` : "; syncing all"}`);

  const tally = { read: 0, suppressed: 0, unchanged: 0, updated: 0, inserted: 0, conflicts: 0, embedded: 0, failed: 0 };
  const claimed = new Set();
  const toEmbed = []; // { id, text }
  let last = "00000000-0000-0000-0000-000000000000";
  const PAGE = 500;
  for (let page = 0; ; page++) {
    const { rows } = await db.query(
      `select v.* from board.candidates v join comms.contacts c on c.id = v.contact_id
        where c.workspace_id = $1 and v.contact_id > $2 ${SINCE ? "and v.updated_at >= $3" : ""}
        order by v.contact_id limit ${PAGE}`,
      SINCE ? [ws.id, last, SINCE] : [ws.id, last]
    );
    if (!rows.length) break;
    last = rows[rows.length - 1].contact_id;
    tally.read += rows.length;
    const ids = rows.map((r) => r.contact_id);
    const harvest = await db.query("select * from comms.harvest_profiles where contact_id = any($1)", [ids]);
    const exps = await db.query("select contact_id, title, company_name, company_linkedin_url, location, start_month, start_year, end_month, end_year, is_current, duration_text, description, sort_order from comms.contact_experiences where contact_id = any($1) and superseded_at is null", [ids]);
    const edus = await db.query("select contact_id, school_name, degree, field_of_study, start_year, end_year, sort_order from comms.contact_educations where contact_id = any($1) and superseded_at is null", [ids]);
    const byContact = (rs) => rs.rows.reduce((m, r) => ((m[r.contact_id] ||= []).push(r), m), {});
    const harvestBy = Object.fromEntries(harvest.rows.map((r) => [r.contact_id, r]));
    const expsBy = byContact(exps);
    const edusBy = byContact(edus);

    // Existing website rows for these contacts, by the strongest link first.
    const existing = new Map(); // contact_id -> row
    for (const part of chunk(ids, 100)) {
      const found = await sb(`candidates?directory_contact_id=in.${inList(part)}&select=id,directory_contact_id,directory_sync_hash,matching_embedding,embedding_type`);
      for (const r of found) existing.set(r.directory_contact_id, r);
    }
    const airtableIds = rows.flatMap((r) => (existing.has(r.contact_id) ? [] : recordIds(r.airtable_record_ids).map((a) => [a, r.contact_id])));
    for (const part of chunk(airtableIds, 100)) {
      const found = await sb(`candidates?airtable_id=in.${inList(part.map(([a]) => a))}&select=id,airtable_id,directory_contact_id,directory_sync_hash,matching_embedding,embedding_type`);
      for (const r of found) {
        const cid = part.find(([a]) => a === r.airtable_id)?.[1];
        if (cid && !existing.has(cid) && (!r.directory_contact_id || r.directory_contact_id === cid)) existing.set(cid, r);
      }
    }
    const mapped = rows.map((r) => ({ row: r, m: mapContact(r, harvestBy[r.contact_id], expsBy[r.contact_id], edusBy[r.contact_id]) }));
    const usernames = mapped.filter(({ row, m }) => !existing.has(row.contact_id) && m.linkedin_username).map(({ m }) => m.linkedin_username);
    for (const part of chunk([...new Set(usernames)], 100)) {
      const found = await sb(`candidates?linkedin_username=in.${inList(part)}&select=id,linkedin_username,directory_contact_id,directory_sync_hash,matching_embedding,embedding_type&order=updated_at.desc`);
      for (const { row, m } of mapped) {
        if (existing.has(row.contact_id) || !m.linkedin_username) continue;
        const r = found.find((x) => x.linkedin_username === m.linkedin_username && (!x.directory_contact_id || x.directory_contact_id === row.contact_id));
        if (r) existing.set(row.contact_id, r);
      }
    }
    const emails = mapped.filter(({ row, m }) => !existing.has(row.contact_id) && m.email).map(({ m }) => m.email.toLowerCase());
    for (const part of chunk([...new Set(emails)], 100)) {
      const found = await sb(`candidates?email=in.${inList(part)}&select=id,email,directory_contact_id,directory_sync_hash,matching_embedding,embedding_type&order=updated_at.desc`);
      for (const { row, m } of mapped) {
        if (existing.has(row.contact_id) || !m.email) continue;
        const r = found.find((x) => x.email && x.email.toLowerCase() === m.email.toLowerCase() && (!x.directory_contact_id || x.directory_contact_id === row.contact_id));
        if (r) existing.set(row.contact_id, r);
      }
    }

    const updates = [];
    const inserts = [];
    const now = new Date().toISOString();
    for (const { row, m } of mapped) {
      const prev = existing.get(row.contact_id);
      const hash = syncHash(m, harvestBy[row.contact_id]?.fetched_at ?? null);
      if (prev && claimed.has(prev.id)) { tally.conflicts++; continue; }
      if (prev) claimed.add(prev.id);
      if (m.status === "Do Not Contact") {
        tally.suppressed++;
        if (prev && prev.directory_sync_hash !== hash) updates.push({ id: prev.id, directory_contact_id: m.directory_contact_id, status: m.status, directory_sync_hash: hash, updated_at: now });
        continue;
      }
      if (prev && prev.directory_sync_hash === hash) {
        tally.unchanged++;
        if (needsEmbedding(prev, m)) toEmbed.push({ id: prev.id, text: embeddingText(m) });
        continue;
      }
      if (prev) {
        updates.push({ id: prev.id, ...patchFor(m), directory_sync_hash: hash, updated_at: now });
        if (needsEmbedding(prev, m)) toEmbed.push({ id: prev.id, text: embeddingText(m) });
      } else inserts.push({ ...m, directory_sync_hash: hash, updated_at: now });
    }
    if (!DRY_RUN) {
      // Rows patched in one request must share one column list.
      const groups = new Map();
      for (const u of updates) (groups.get(Object.keys(u).sort().join(",")) || groups.set(Object.keys(u).sort().join(","), []).get(Object.keys(u).sort().join(","))).push(u);
      for (const rows of groups.values()) for (const part of chunk(rows, 200)) {
        await sb("candidates?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(part) });
      }
      for (const part of chunk(inserts, 200)) {
        const made = await sb("candidates?select=id,directory_contact_id", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(part) });
        const idOf = Object.fromEntries(made.map((r) => [r.directory_contact_id, r.id]));
        for (const i of part) if (idOf[i.directory_contact_id]) toEmbed.push({ id: idOf[i.directory_contact_id], text: embeddingText(i) });
      }
    }
    tally.updated += updates.length;
    tally.inserted += inserts.length;
    if (page % 10 === 0 || rows.length < PAGE) console.log(`page ${page}: read ${tally.read}, ${DRY_RUN ? "would update" : "updated"} ${tally.updated}, ${DRY_RUN ? "would insert" : "inserted"} ${tally.inserted}, unchanged ${tally.unchanged}, do-not-contact ${tally.suppressed}, conflicts ${tally.conflicts}`);
    if (LIMIT && tally.read >= LIMIT) break;
  }
  await db.end();

  if (!DRY_RUN && toEmbed.length) {
    for (const part of chunk(toEmbed, 64)) {
      const res = await fetch("https://api.openai.com/v1/embeddings", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "text-embedding-3-small", input: part.map((p) => p.text.slice(0, 8000)) }) });
      if (!res.ok) { tally.failed += part.length; console.log(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`); continue; }
      const { data } = await res.json();
      await sb("candidates?on_conflict=id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(part.map((p, i) => ({ id: p.id, matching_embedding: JSON.stringify(data[i].embedding), embedding_type: "directory" }))) });
      tally.embedded += part.length;
    }
  }
  console.log(`${DRY_RUN ? "dry run" : "done"}: read ${tally.read}, ${DRY_RUN ? "would update" : "updated"} ${tally.updated}, ${DRY_RUN ? "would insert" : "inserted"} ${tally.inserted}, unchanged ${tally.unchanged}, do-not-contact ${tally.suppressed}, conflicts ${tally.conflicts}, embedded ${tally.embedded}${DRY_RUN ? ` (would embed ${toEmbed.length + tally.inserted})` : ""}, failed ${tally.failed}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}

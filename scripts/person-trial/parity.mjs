#!/usr/bin/env node
// Parity of the person translators against what the pool shows today, on a
// sample of real people. READ-ONLY: every request is a GET; nothing is
// written anywhere but the optional local detail file.
//
//   node scripts/build-worker-lib.mjs
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/person-trial/parity.mjs
//   N=300            people in the sample (spread across the kinds below)
//   SEED=1           the sample's seed (same seed, same people)
//   OUT=/tmp/x.json  per-person results (candidate ids and difference classes;
//                    keep it local, never commit it)
//
// Prints counts only: no names, addresses or titles. The checks:
//  (a) jobs == the positions poolExperiences reads today (old import) or the
//      positions harvestToPoolRecord writes from the same payload (Harvest),
//      except exact duplicates and empty positions, with the real job first;
//  (b) every job with a company has a company identity;
//  (c) educations == poolEducation (the lines), plus years where the raw has them;
//  (d) skills cover today's top_skills;
//  (e) every e-mail poolEmails (lib/server/network.ts) would show is in the contacts;
//  (f) project() gives today's current_title, current_company and number of
//      positions for people whose row that source wrote.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const L = await import(path.join(root, "scripts/dist/worker-lib.mjs"));
// A doc leaves out a list its source has nothing for; the checks below read an absent list as empty.
const withLists = (d) => ({ ...d, jobs: d.jobs ?? [], educations: d.educations ?? [], skills: d.skills ?? [] });
const T = {
  fromLegacyImport: (...a) => withLists(L.fromLegacyImport(...a)),
  fromHarvest: (...a) => withLists(L.fromHarvest(...a)),
  fromDirectory: (...a) => withLists(L.fromDirectory(...a)),
};
const BASE = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!BASE || !KEY) throw new Error("Missing env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
const N = Math.max(20, parseInt(process.env.N || "300", 10) || 300);
const TT = L.TT_ORG_ID;

// ---------- read-only REST ----------
async function get(p, tries = 3) {
  for (let t = 1; ; t++) {
    const res = await fetch(`${BASE}/rest/v1/${p}`, { method: "GET", headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(90_000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
    if (res.ok) return res.json();
    const why = (await res.text()).slice(0, 160).replace(/"details":.*$/, "");
    if (t >= tries) throw new Error(`GET ${p.split("?")[0]} ${res.status}: ${why}`);
    await new Promise((r) => setTimeout(r, 1500 * t));
  }
}
const inList = (ids) => `(${ids.map((i) => `"${i}"`).join(",")})`;
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// A small seeded generator so a run can be repeated.
let seed = parseInt(process.env.SEED || "1", 10) || 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const randomUuid = () => {
  const h = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const COLS = [
  "id", "created_at", "source", "full_name", "headline", "profile_summary", "location", "profile_picture_url", "linkedin_username", "linkedin_url",
  "airtable_id", "directory_contact_id", "email", "phone", "contact", "work_experience", "education", "education_schools", "education_degrees",
  "education_fields", "top_skills", "all_skills_text", "skills_endorsements", "linkedin_data", "linkedin_enrichment_date", "current_title",
  "current_company", "previous_companies", "calculated_experience_years", "total_experience_years",
].join(",");

// ---------- the sample ----------
const kinds = new Map(); // id -> kind
const want = (kind, ids, n) => {
  let added = 0;
  for (const id of ids) {
    if (added >= n) break;
    if (!kinds.has(id)) {
      kinds.set(id, kind);
      added++;
    }
  }
  return added;
};
const q = (share) => Math.max(3, Math.round((N * share) / 100));

async function windows(filter, perWindow, count, select = "id") {
  const out = [];
  for (let i = 0; i < count; i++) out.push(...(await get(`candidates?${filter}&id=gt.${randomUuid()}&order=id&limit=${perWindow}&select=${select}`)));
  return out;
}

// Old-import people, both stored shapes, and rows whose jobs live only in the raw JSON.
const linkedinRows = await windows("source=eq.LinkedIn", 80, 8, "id,work_experience->0,linkedin_data->data->basic_info->>urn,linkedin_data->>urn");
const shapeOf = (r) => {
  const first = r.work_experience;
  if (first && typeof first === "object") return "companyName" in first || "companyId" in first ? "shape2" : "shape1";
  return "no_work_experience";
};
const byShape = { shape1: [], shape2: [], no_work_experience: [] };
for (const r of linkedinRows) byShape[shapeOf(r)].push(r.id);
want("legacy_shape1", byShape.shape1, q(22));
want("legacy_shape2", byShape.shape2, q(10));
want("legacy_no_work_experience", byShape.no_work_experience, q(5));
// Shape 2 is about one row in fifteen: look for more when the windows were short of them.
if (byShape.shape2.length < q(10)) {
  const more = await windows("source=eq.LinkedIn&work_experience->0->>companyName=not.is.null", 20, 3);
  want("legacy_shape2", more.map((r) => r.id), q(10) - byShape.shape2.length);
}
// Directory people (their stored jobs came from the directory's Harvest copy).
want("directory", (await windows("source=eq.directory", 60, 3)).map((r) => r.id), q(18));
want("airtable_sync", (await get("candidates?source=eq.airtable_sync&select=id&limit=40")).map((r) => r.id), 4);
want("sourced", (await get("candidates?source=eq.Sourced&select=id&limit=40")).map((r) => r.id), 4);
// People the website refreshed from Harvest.
const ledger = await get(`candidate_enrichments?provider=eq.harvest&status=eq.ok&raw_payload=not.is.null&candidate_id=not.is.null&select=candidate_id,created_at&order=created_at.desc&limit=3000`);
const harvestIds = [...new Set(ledger.map((r) => r.candidate_id))].sort(() => rand() - 0.5);
want("harvest", harvestIds, q(22));
// Many e-mails, phones, the curated contact, linked TT applications.
// Windows ordered by candidate_id keep each person's rows together, so the counts are whole.
const emailRows = [];
for (let i = 0; i < 4; i++) emailRows.push(...(await get(`candidate_emails?candidate_id=gt.${randomUuid()}&order=candidate_id&limit=1000&select=candidate_id`)));
const perCand = new Map();
for (const r of emailRows) perCand.set(r.candidate_id, (perCand.get(r.candidate_id) || 0) + 1);
want("emails_4plus", [...perCand].filter(([, n]) => n >= 4).map(([id]) => id), q(6));
want("emails_any", [...perCand.keys()], q(4));
want("phone", (await get("candidates?phone=not.is.null&select=id&limit=400")).map((r) => r.id).sort(() => rand() - 0.5), q(4));
want("curated_contact", (await get("candidates?contact=not.is.null&select=id&limit=5")).map((r) => r.id), 5);
// People on the Network tab, and people who are not (everyone above who has no row there).
const net = [];
for (let i = 0; i < 3; i++) net.push(...(await get(`network_matches?organization_id=eq.${TT}&candidate_id=gt.${randomUuid()}&order=candidate_id&limit=200&select=candidate_id`)));
want("network", [...new Set(net.map((r) => r.candidate_id))], q(8));
const apps = await get(`website_applications?organization_id=eq.${TT}&candidate_id=not.is.null&select=*`);
want("tt_application", apps.map((a) => a.candidate_id), 10);

const ids = [...kinds.keys()];

// ---------- read everything for the sample ----------
const rows = new Map(), v1 = new Map(), v2 = new Map(), payloads = new Map(), appsBy = new Map();
const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
for (const part of chunk(ids, 40)) {
  for (const r of await get(`candidates?id=in.${inList(part)}&select=${COLS}`)) rows.set(r.id, r);
  for (const r of await get(`candidate_emails?candidate_id=in.${inList(part)}&select=*`)) push(v1, r.candidate_id, r);
  for (const r of await get(`candidate_emails_v2?candidate_id=in.${inList(part)}&select=*`)) push(v2, r.candidate_id, r);
  for (const r of await get(`candidate_enrichments?candidate_id=in.${inList(part)}&provider=eq.harvest&status=eq.ok&raw_payload=not.is.null&select=id,candidate_id,created_at,provider,operation,raw_payload&order=created_at.desc`)) {
    if (!payloads.has(r.candidate_id)) payloads.set(r.candidate_id, r);
  }
}
for (const a of apps) push(appsBy, a.candidate_id, a);
const signals = new Map(), onNetwork = new Set();
for (const part of chunk(ids, 40)) {
  for (const r of await get(`person_signals?candidate_id=in.${inList(part)}&select=candidate_id,years,positions,current_title,source_hash,computed_at`)) signals.set(r.candidate_id, r);
  for (const r of await get(`network_matches?organization_id=eq.${TT}&candidate_id=in.${inList(part)}&select=candidate_id`)) onNetwork.add(r.candidate_id);
}

// ---------- comparison helpers ----------
const nn = (s) => L.normalizedName(s) || "";
const nt = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, " ").trim();
const tally = {};
const bump = (k, n = 1) => (tally[k] = (tally[k] || 0) + n);
const details = [];

/** Reference positions (today's), with the same drops the doc makes, then the real job first. */
function reference(rowsIn) {
  let empty = 0, dups = 0;
  const seen = new Set();
  const kept = [];
  for (const r of rowsIn) {
    if (!r.title && !r.company_name) { empty++; continue; }
    const exact = JSON.stringify([nt(r.title), nn(r.company_name), r.start_year, r.start_month, r.end_year, r.end_month, !!r.is_current, r.location || null, (r.description || "").trim() || null]);
    if (seen.has(exact)) { dups++; continue; }
    seen.add(exact);
    kept.push({ ...r, is_current: !!r.is_current, is_side_role: L.isSideRole(r.title, r.company_name) });
  }
  return { list: L.realJobFirst(kept), empty, dups };
}
const jobKey = (title, company, y, m) => `${nt(title)}|${nn(company)}|${y ?? ""}-${m ?? ""}`;

function compareJobs(doc, refRows, label, rec) {
  const ref = reference(refRows);
  bump(`${label}.a.positions_today`, refRows.length);
  bump(`${label}.a.jobs_in_doc`, doc.jobs.length);
  if (ref.empty) { bump(`${label}.a.diff.empty_position_dropped`, ref.empty); rec.push("empty_position_dropped"); }
  if (ref.dups) { bump(`${label}.a.diff.exact_duplicate_dropped`, ref.dups); rec.push("exact_duplicate_dropped"); }
  const want = ref.list.map((r) => jobKey(r.title, r.company_name, r.start_year, r.start_month));
  const got = doc.jobs.map((j) => jobKey(j.title, j.company.name, j.start_year, j.start_month));
  const extra = got.length - want.length;
  if (JSON.stringify(want) === JSON.stringify(got)) bump(`${label}.a.match`);
  else if (extra > 0 && JSON.stringify(got.slice(0, want.length)) === JSON.stringify(want)) { bump(`${label}.a.diff.more_than_25_positions_kept`); rec.push("more_than_25_positions_kept"); }
  else if (JSON.stringify([...want].sort()) === JSON.stringify([...got].sort())) { bump(`${label}.a.diff.order`); rec.push("order"); }
  else { bump(`${label}.a.diff.content`); rec.push("jobs_content"); }
  // The real current job first.
  const real = doc.jobs.findIndex((j) => j.is_current && !j.is_side_role);
  if (real > 0) { bump(`${label}.a.real_job_not_first`); rec.push("real_job_not_first"); }
  const firstTodaySide = refRows.length && L.isSideRole(refRows[0].title, refRows[0].company_name) && doc.jobs.length && !doc.jobs[0].is_side_role;
  if (firstTodaySide) { bump(`${label}.a.side_role_moved_after_real_job`); rec.push("side_role_moved"); }
}

function jobIdentity(doc, label) {
  for (const j of doc.jobs) {
    if (!j.company.name && !j.company.identity) { bump(`${label}.b.jobs_without_company`); continue; }
    bump(`${label}.b.jobs_with_company`);
    if (!j.company.identity) bump(`${label}.b.FAIL_no_identity`);
    else bump(`${label}.b.identity.${j.company.is_placeholder ? "placeholder" : j.company.identity.split(":")[0]}`);
    if (j.company.tier) bump(`${label}.b.tiered`);
  }
}

function compareEducation(doc, refEdu, label, rec, rawHasYears) {
  const want = refEdu.map((e) => nn(e.schoolName));
  const got = doc.educations.map((e) => nn(e.school.name));
  bump(`${label}.c.schools_today`, want.length);
  bump(`${label}.c.schools_in_doc`, got.length);
  if (JSON.stringify(want) === JSON.stringify(got)) bump(`${label}.c.schools_match`);
  else if (JSON.stringify([...want].sort()) === JSON.stringify([...got].sort())) { bump(`${label}.c.diff.order`); rec.push("edu_order"); }
  else if (!want.length && got.length) { bump(`${label}.c.diff.raw_has_schools_lines_do_not`); rec.push("edu_raw_only"); }
  else if (want.length && !got.length) { bump(`${label}.c.diff.lines_have_schools_doc_does_not`); rec.push("edu_missing"); }
  else if (got.length > want.length && want.every((w) => got.includes(w))) { bump(`${label}.c.diff.raw_has_more_schools`); rec.push("edu_raw_more"); }
  else if (got.length < want.length && got.every((g) => want.includes(g))) { bump(`${label}.c.diff.lines_have_more_schools`); rec.push("edu_lines_more"); }
  else { bump(`${label}.c.diff.school_names_differ`); rec.push("edu_names_differ"); }
  // Degree + field, as one text, where the school sequences agree.
  if (JSON.stringify(want) === JSON.stringify(got)) {
    let same = 0;
    refEdu.forEach((e, i) => {
      const a = nt([e.degree, e.fieldOfStudy].filter(Boolean).join(" in "));
      const d = doc.educations[i];
      const b = nt([d.degree, d.field_of_study].filter(Boolean).join(" in "));
      if (a === b) same++;
    });
    bump(`${label}.c.degree_field_same`, same);
    bump(`${label}.c.degree_field_differ`, refEdu.length - same);
  }
  const withYears = doc.educations.filter((e) => e.end_year || e.start_year).length;
  bump(`${label}.c.educations_with_years`, withYears);
  if (rawHasYears && !withYears) { bump(`${label}.c.FAIL_raw_years_lost`); rec.push("edu_years_lost"); }
  for (const e of doc.educations) bump(`${label}.c.school_identity.${e.school.identity.split(":")[0]}`);
}

function compareSkills(doc, todaySkills, label, rec) {
  const keys = new Set(doc.skills.map((s) => s.key));
  let missing = 0, filler = 0, long = 0;
  for (const s of todaySkills || []) {
    const split = L.splitSkill(s);
    if (!split) continue;
    if (split.name.length > 60) { long++; continue; }
    if (/^(none|n\/?a|na|nil|null|not specified|unspecified|flexible|other|others|various|misc|-+|\.+|\?+|tbd|no skills?)$/i.test(split.name.trim())) { filler++; continue; }
    if (!keys.has(L.skillKeyOf(split.name))) missing++;
  }
  bump(`${label}.d.top_skills_today`, (todaySkills || []).length);
  bump(`${label}.d.skills_in_doc`, doc.skills.length);
  if (missing) { bump(`${label}.d.FAIL_people_missing_a_top_skill`); bump(`${label}.d.missing_top_skills`, missing); rec.push("skills_missing"); }
  if (filler) { bump(`${label}.d.diff.filler_dropped`, filler); rec.push("skill_filler_dropped"); }
  if (long) { bump(`${label}.d.diff.over_60_chars_dropped`, long); rec.push("skill_long_dropped"); }
  if ((todaySkills || []).length && !missing) bump(`${label}.d.people_covered`);
}

/** What poolEmails shows today: candidates.contact.email or .email, then the verification tables minus verified-dead. */
function poolEmailSet(row, e1, e2) {
  const out = new Set();
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const known = str(row.contact?.email ?? null) ?? str(row.email);
  if (known) out.add(known);
  for (const r of [...e1.map((r) => ({ ...r, email: r.email_address })), ...e2.map((r) => ({ ...r, email: r.email_normalized }))]) {
    if (!str(r.email)) continue;
    if (r.quality === "bad" || r.result === "invalid") continue;
    out.add(str(r.email));
  }
  return out;
}

/** The directory's rows for a Harvest payload, the way reply-ops stores them
 *  (a port of harvest_enrich.parse_profile, for this test only): the input
 *  fromDirectory would get when the directory fetched the same profile. */
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const rMonth = (v) => { if (v == null) return null; const t = String(v).trim().toLowerCase().slice(0, 3); return MON[t] ?? (/^\d+$/.test(t) && +t >= 1 && +t <= 12 ? +t : null); };
const rYear = (v) => { const y = parseInt(v, 10); return Number.isFinite(y) && y >= 1900 && y <= 2100 ? y : null; };
function commsRowsFromHarvest(h) {
  const exps = (Array.isArray(h.experience) ? h.experience : []).map((e, i) => {
    const start = e.startDate || {}, end = e.endDate || {};
    const { companyLogo, ...raw } = e;
    return {
      title: e.position || "", company_name: e.companyName || "", company_linkedin_url: e.companyLinkedinUrl || "", company_universal_name: e.companyUniversalName || "",
      company_linkedin_id: String(e.companyId || ""), employment_type: e.employmentType || "", location: e.location || "",
      start_month: rMonth(start.month), start_year: rYear(start.year), end_month: rMonth(end.month), end_year: rYear(end.year),
      is_current: String(end.text || "").toLowerCase() === "present" || (!end.year && !!start.year),
      duration_text: e.duration || "", description: (e.description || "").slice(0, 4000), skills: Array.isArray(e.skills) ? e.skills.map(String).slice(0, 30) : [], raw, sort_order: i,
    };
  });
  const edus = (Array.isArray(h.education) ? h.education : []).map((ed, i) => {
    const start = ed.startDate || {}, end = ed.endDate || {};
    const { schoolLogo, ...raw } = ed;
    return { school_name: ed.schoolName || "", school_linkedin_url: ed.schoolLinkedinUrl || "", degree: ed.degree || "", field_of_study: ed.fieldOfStudy || "", start_year: rYear(start.year), end_year: rYear(end.year), description: (ed.description || "").slice(0, 2000), raw, sort_order: i };
  });
  const skills = (Array.isArray(h.skills) ? h.skills : []).map((s) => (s && typeof s === "object" ? s.name : String(s))).slice(0, 80);
  return { exps, edus, skills };
}

// ---------- run ----------
let errors = 0;
const same = (a, b) => nt(a) === nt(b);
for (const id of ids) {
  const row = rows.get(id);
  const kind = kinds.get(id);
  const rec = { id, kind, classes: [] };
  if (!row) { bump("sample.row_missing"); continue; }
  bump(`sample.${kind}`);
  bump(`sample.on_network_tab.${onNetwork.has(id) ? "yes" : "no"}`);
  try {
    const e1 = v1.get(id) || [], e2 = v2.get(id) || [];
    const legacy = T.fromLegacyImport(row, e1, e2);
    if (T.fromLegacyImport(row, e1, e2).source.payload_hash !== legacy.source.payload_hash) { bump("FAIL_not_deterministic"); rec.classes.push("not_deterministic"); }
    for (const list of [legacy.jobs, legacy.educations]) if (new Set(list.map((x) => x.row_key)).size !== list.length) { bump("FAIL_duplicate_row_key"); rec.classes.push("dup_row_key"); }
    for (const j of legacy.jobs) if (!j.row_key || j.row_key.length !== 32) bump("FAIL_bad_row_key");
    if (new Set(legacy.skills.map((x) => x.key)).size !== legacy.skills.length) bump("FAIL_duplicate_skill_key");
    if (new Set(legacy.contacts.map((c) => `${c.kind}|${c.value_normalized}`)).size !== legacy.contacts.length) bump("FAIL_duplicate_contact");
    if (legacy.contacts.filter((c) => c.source_detail === "directory_primary").length > 1) bump("FAIL_two_directory_primaries");
    if (legacy.educations.some((e) => !e.school.name)) bump("FAIL_school_without_name");

    const raw = L.legacyRaw(row.linkedin_data);
    rec.generation = raw.generation;
    bump(`legacy.raw_generation.${raw.generation || "none"}`);
    const stored = Array.isArray(row.work_experience) ? row.work_experience.filter((p) => p && typeof p === "object") : [];
    bump(`legacy.jobs_from.${stored.length ? "work_experience" : raw.experience.length ? "linkedin_data" : "none"}`);

    // Which route wrote today's lists: the old import, the directory, or the Harvest refresh.
    const led = payloads.get(id);
    const recd = led ? L.harvestToPoolRecord(led.raw_payload) : null;
    const harvestWrote = !!recd && JSON.stringify((recd.work_experience || []).map((x) => [x.title, x.company])) === JSON.stringify(stored.map((x) => [x.title ?? null, x.company ?? x.companyName ?? null]));
    const writer = harvestWrote ? "harvest" : row.source === "LinkedIn" ? "old_import" : row.source === "directory" ? "directory" : row.source;
    bump(`today_lists_written_by.${writer}`);
    rec.writer = writer;
    const lg = writer === "old_import" ? "legacy.old_import_rows" : "legacy.rewritten_rows";

    // (a) (b) the jobs, against the positions poolExperiences reads from this row.
    const todayRows = stored.length ? L.poolExperiences(row) : L.poolExperiences({ id, work_experience: raw.experience });
    compareJobs(legacy, todayRows, "legacy", rec.classes);
    jobIdentity(legacy, "legacy");
    const restored = legacy.jobs.filter((j) => {
      const p = stored.find((s) => nn(s.company ?? s.companyName) === nn(j.company.name));
      return p && !(p.company_id || p.companyId || p.companyUsername || /linkedin\.com\/(company|school|showcase)\//i.test(p.company_linkedin_url || p.companyURL || "")) && (j.company.linkedin_id || j.company.linkedin_username);
    }).length;
    if (restored) bump("legacy.b.company_identity_restored_from_raw", restored);

    // (c) schools: the lines today against the doc (raw JSON when present).
    const rawYears = raw.education.some((e) => ((e.end_date || e.end || {}).year || (e.start_date || e.start || {}).year));
    const edClasses = [];
    compareEducation(legacy, L.poolEducation(row), lg, edClasses, rawYears);
    rec.classes.push(...edClasses);
    if (edClasses.length && writer === "old_import") {
      // Why: today's line parser cuts names at the first " - ", misses literal "\n", keeps " in Field".
      const text = String(row.education || "");
      const why = /\\n/.test(text) ? "education_text_has_literal_backslash_n"
        : raw.education.some((e) => / - /.test(e.school ?? e.schoolName ?? "")) ? "school_name_contains_dash_cut_by_line_parser"
        : L.poolEducation(row).some((e) => / in /i.test(e.schoolName)) ? "line_without_degree_keeps_in_field_in_school"
        : !raw.education.length ? "no_raw_education"
        : "school_name_differs_between_lines_and_raw";
      bump(`${lg}.c.why.${why}`);
    }
    compareSkills(legacy, row.top_skills, "legacy", rec.classes);

    // (e) every address poolEmails would show.
    const shown = poolEmailSet(row, e1, e2);
    const inDoc = new Map(legacy.contacts.filter((c) => c.kind === "email").map((c) => [c.value_normalized, c]));
    let missing = 0, notAddress = 0;
    for (const e of shown) {
      const n = L.normalizeEmail(e);
      if (!n) {
        notAddress++;
        if (!inDoc.has(e.trim().toLowerCase())) missing++;
      } else if (!inDoc.has(n)) missing++;
    }
    bump("legacy.e.addresses_poolEmails_shows", shown.size);
    if (shown.size) bump("legacy.e.people_with_addresses");
    if (missing) { bump("legacy.e.FAIL_missing", missing); rec.classes.push("email_missing"); }
    if (notAddress) { bump("legacy.e.diff.not_an_address_kept_as_invalid", notAddress); rec.classes.push("email_not_an_address"); }
    const ranked = L.rankedContacts(legacy.contacts, "email");
    if (ranked.length) bump("legacy.e.people_with_a_primary");
    else if (shown.size) { bump("legacy.e.diff.shown_today_but_none_usable"); rec.classes.push("no_usable_email"); }
    const emails = legacy.contacts.filter((c) => c.kind === "email");
    bump(`legacy.e.emails_per_person.${emails.length >= 4 ? "4+" : emails.length}`);
    for (const c of legacy.contacts) bump(`legacy.contacts.${c.kind}.${c.status}${c.never_primary ? ".never_primary" : ""}${c.is_manual ? ".manual" : ""}`);
    const first = [...shown][0] ? L.normalizeEmail([...shown][0]) : null;
    if (ranked[0] && first && first !== ranked[0].value_normalized) {
      const f = inDoc.get(first);
      const why = !f ? "network_first_not_in_doc"
        : f.status === "invalid" ? "network_first_is_marked_bad_by_the_old_checks"
        : !f.quality && !f.result ? `network_first_is_an_unchecked_candidates_email_(${row.source === "directory" ? "directory_primary_on_its_own_doc" : "old_import"})`
        : ["risky", "unknown"].includes(String(f.quality)) || String(f.result) === "catch_all" ? "network_first_is_risky"
        : f.label !== "personal" && ranked[0].label === "personal" ? "verified_personal_beats_business"
        : f.label === ranked[0].label && f.quality === ranked[0].quality && /:primary$/.test(ranked[0].source_detail || "") ? `tie_old_tables_primary_beats_candidates_email_(${row.source === "directory" ? "directory_primary_on_its_own_doc" : "old_import"})`
        : f.label === ranked[0].label && f.quality === ranked[0].quality ? "tie_between_equal_addresses_no_primary_flag_(order_arbitrary_today)"
        : "other";
      bump(`legacy.e.primary_differs_from_network_first.${why}`);
      rec.classes.push(`primary_${why}`);
    }

    // (f) the projection, for rows the old import (or the directory, relabelled) still owns.
    const p = L.project(legacy);
    const todayLen = Array.isArray(row.work_experience) ? row.work_experience.length : 0;
    if (stored.length && !harvestWrote) {
      bump(`${lg}.f.people`);
      if (same(p.current_title, row.current_title)) bump(`${lg}.f.current_title_same`);
      else {
        const first0 = todayRows[0];
        const cls = !row.current_title ? "today_empty"
          : first0 && same(first0.title, row.current_title) && L.isSideRole(first0.title, first0.company_name) ? "side_role_first_today_real_job_now_first"
          : first0 && same(first0.title, row.current_title) ? "first_position_is_not_the_current_real_job"
          : todayRows.some((r) => same(r.title, row.current_title)) ? "today_title_is_a_later_position"
          : "today_title_not_in_positions";
        bump(`${lg}.f.current_title_diff.${cls}`); rec.classes.push(`title_${cls}`);
      }
      if (same(p.current_company, row.current_company)) bump(`${lg}.f.current_company_same`);
      else {
        const cls = !row.current_company ? "today_empty" : todayRows.some((r) => same(r.company_name, row.current_company)) ? "different_position" : "today_company_not_in_positions";
        bump(`${lg}.f.current_company_diff.${cls}`); rec.classes.push(`company_${cls}`);
      }
      if (p.work_experience.length === todayLen) bump(`${lg}.f.positions_same`);
      else { bump(`${lg}.f.positions_diff.${p.work_experience.length < todayLen ? "fewer_(duplicates_or_empty_dropped)" : "more"}`); rec.classes.push("positions_count"); }
      const pc = Array.isArray(row.previous_companies) ? row.previous_companies : null;
      if (pc) bump(`${lg}.f.previous_companies_${JSON.stringify(pc.map(nn)) === JSON.stringify(p.previous_companies.map(nn)) ? "same" : "differ_(no_single_rule_today)"}`);
    }
    // Years: the signals job's number today against computeFacts over the projected columns.
    const sig = signals.get(id);
    if (sig && sig.years != null && p.career_years_today_rule != null && !harvestWrote && stored.length) {
      const d = Math.abs(sig.years - p.career_years_today_rule);
      bump(`${lg}.f.years_vs_person_signals.${d <= 0.2 ? "same_(within_0.2)" : "differ"}`);
      if (d > 0.2) rec.classes.push("years_differ");
    }
    if (p.career_years != null && p.career_years_today_rule != null) bump(`legacy.f.years_with_school_years_${Math.abs(p.career_years - p.career_years_today_rule) <= 0.05 ? "same" : "differ"}`);

    // Harvest: the doc against what harvestToPoolRecord writes from the same payload.
    if (led) {
      const doc = T.fromHarvest(led.raw_payload, led);
      if (T.fromHarvest(led.raw_payload, led).source.payload_hash !== doc.source.payload_hash) bump("FAIL_not_deterministic");
      for (const list of [doc.jobs, doc.educations]) if (new Set(list.map((x) => x.row_key)).size !== list.length) bump("FAIL_duplicate_row_key");
      const recRows = L.poolExperiences({ id, work_experience: recd.work_experience || [] });
      compareJobs(doc, recRows, "harvest", rec.classes);
      jobIdentity(doc, "harvest");
      const hRawYears = (led.raw_payload.education || []).some((e) => e?.startDate?.year || e?.endDate?.year || e?.period);
      const hEd = [];
      compareEducation(doc, L.poolEducation({ id, education: recd.education || null }), "harvest", hEd, hRawYears);
      rec.classes.push(...hEd.map((c) => `harvest_${c}`));
      if (hEd.length) bump(`harvest.c.why.${doc.educations.some((e) => / - /.test(e.school.name)) ? "school_name_contains_dash_cut_by_line_parser" : doc.educations.some((e) => !e.degree && e.field_of_study) ? "line_without_degree_keeps_in_field_in_school" : "other"}`);
      compareSkills(doc, recd.top_skills, "harvest", rec.classes);
      const hp = L.project(doc);
      bump("harvest.f.people");
      bump(`harvest.f.current_title_${same(hp.current_title, recd.current_title) ? "same" : "differ"}`);
      bump(`harvest.f.current_company_${same(hp.current_company, recd.current_company) ? "same" : "differ"}`);
      bump(`harvest.f.positions_${hp.work_experience.length === (recd.work_experience || []).length ? "same" : "differ"}`);
      if (harvestWrote) {
        bump(`harvest.f.vs_row.current_title_${same(hp.current_title, row.current_title) ? "same" : "differ"}`);
        bump(`harvest.f.vs_row.current_company_${same(hp.current_company, row.current_company) ? "same" : "differ"}`);
        bump(`harvest.f.vs_row.positions_${hp.work_experience.length === todayLen ? "same" : "differ"}`);
        if (hp.career_years_today_rule != null && row.calculated_experience_years != null) bump(`harvest.f.vs_row.years_${Math.round(hp.career_years_today_rule) === row.calculated_experience_years ? "same" : Math.abs(Math.round(hp.career_years_today_rule) - row.calculated_experience_years) <= 1 ? "within_1_(computed_on_an_earlier_day)" : "differ"}`);
        if (sig && sig.years != null && hp.career_years_today_rule != null) bump(`harvest.f.vs_row.years_vs_person_signals.${Math.abs(sig.years - hp.career_years_today_rule) <= 0.2 ? "same_(within_0.2)" : "differ"}`);
      }
      bump(`newest_source.${doc.source.fetched_at > legacy.source.fetched_at ? "harvest" : "legacy"}`);

      // The same profile through the directory route: the same jobs and schools, keyed the same way.
      const sim = commsRowsFromHarvest(led.raw_payload);
      const dd = T.fromDirectory({ contact_id: "00000000-0000-4000-8000-000000000000", updated_at: led.created_at }, { fetched_at: led.created_at, public_identifier: led.raw_payload.publicIdentifier, skills: sim.skills, raw: led.raw_payload }, sim.exps, sim.edus, [], [], id);
      const hk = doc.jobs.map((j) => j.row_key), dk = dd.jobs.map((j) => j.row_key);
      bump(`directory_sim.jobs.${JSON.stringify(hk) === JSON.stringify(dk) ? "same_keys_same_order" : JSON.stringify([...hk].sort()) === JSON.stringify([...dk].sort()) ? "same_keys_other_order" : "different_keys"}`);
      const cur = doc.jobs.filter((j, i) => dd.jobs.find((x) => x.row_key === j.row_key)?.is_current !== j.is_current).length;
      if (cur) bump("directory_sim.jobs.is_current_differs_(reply-ops marks undated positions current)", cur);
      const he = doc.educations.map((e) => e.row_key).sort(), de = dd.educations.map((e) => e.row_key).sort();
      bump(`directory_sim.educations.${JSON.stringify(he) === JSON.stringify(de) ? "same_keys" : "different_keys"}`);
      const hs = new Set(doc.skills.map((x) => x.key)), ds = new Set(dd.skills.map((x) => x.key));
      bump(`directory_sim.skills.${[...hs].every((k) => ds.has(k)) ? "same" : "directory_has_fewer_(80_cap)"}`);
      bump(`directory_sim.mode.${dd.mode}`);
    }

    for (const a of appsBy.get(id) || []) {
      const d = L.fromApplication(a, false);
      bump("application.docs");
      for (const c of d.contacts) bump(`application.contacts.${c.kind}.${c.status}`);
    }
  } catch (err) {
    errors++;
    bump("ERRORS");
    rec.classes.push(`error:${String(err.message).slice(0, 80)}`);
  }
  details.push(rec);
}

const ordered = Object.fromEntries(Object.entries(tally).sort(([a], [b]) => a.localeCompare(b)));
console.log(JSON.stringify({ people: ids.length, errors, counts: ordered }, null, 1));
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(details, null, 1));

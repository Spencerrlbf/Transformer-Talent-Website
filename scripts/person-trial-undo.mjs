#!/usr/bin/env node
// Undo the person-writer trial for the given candidate ids: deletes their rows
// from the new tables (migration 072) and then the companies and schools the
// writer created (created_from = 'person_writer') that nothing references any
// more. The candidates rows, and candidate_experiences rows written by anything
// other than the writer (source <> 'person'), are never touched. The shared skill
// dictionary is kept; the skills nobody uses any more are only counted.
// Prints counts only. A dry run (the default) counts what it would delete.
//
//   node scripts/person-trial-undo.mjs --ids <id,id,...>   (or --file ids.txt | ids.json, or TRIAL_IDS)
//   DRY_RUN=0 node scripts/person-trial-undo.mjs --ids ...  (or --apply): delete
//
// The website database as in person-trial.mjs: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY,
// or LOCAL_DATABASE_URL for a local test.
import { pathToFileURL } from "node:url";
import { falsy, openSite, parseIds, redact, selectIn } from "./person-trial.mjs";

const uniq = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined))];

/** Ids among `ids` that some row of `table` still points at through `col`. */
async function referenced(site, table, col, ids, filters = []) {
  const rows = await selectIn(site, table, col, ids, { columns: col, filters, order: `${col}.asc` });
  return new Set(rows.map((r) => r[col]));
}

export async function undo(site, ids, { apply }) {
  const out = [];
  // What the trial left, per table (read first so a dry run can count it).
  const rows = async (table, order, extra = []) => selectIn(site, table, "candidate_id", ids, { filters: extra, order });
  const sources = await rows("candidate_sources", "id.asc");
  const sourceIds = uniq(sources.map((s) => s.id));
  const contacts = await rows("candidate_contacts", "id.asc");
  const cskills = await rows("candidate_skills", "candidate_id.asc,skill_id.asc");
  const educations = await rows("candidate_educations", "id.asc");
  const jobs = await rows("candidate_experiences", "id.asc", [["source", "eq", "person"]]);
  const identities = await rows("candidate_identities", "id.asc");
  const state = await rows("candidate_profile_state", "candidate_id.asc");
  const conflicts = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    for (const c of await site.select("identity_conflicts", { filters: [["candidate_ids", "ov", ids.slice(i, i + 40)]], order: "id.asc" })) conflicts.set(c.id, c);
  }
  for (const c of await selectIn(site, "identity_conflicts", "source_id", sourceIds, { order: "id.asc" })) conflicts.set(c.id, c);
  const skillIds = uniq(cskills.map((s) => s.skill_id));

  // Children first: every row pointing at candidate_sources goes before it.
  const byIds = (col, values) => [[col, "in", values]];
  const chunked = async (label, table, col, values, extra = [], total) => {
    if (!apply) return out.push([label, total]);
    let n = 0;
    for (let i = 0; i < values.length; i += 40) n += await site.remove(table, [...byIds(col, values.slice(i, i + 40)), ...extra]);
    out.push([label, n]);
  };
  await chunked("candidate_contacts", "candidate_contacts", "candidate_id", ids, [], contacts.length);
  await chunked("candidate_skills", "candidate_skills", "candidate_id", ids, [], cskills.length);
  await chunked("candidate_educations", "candidate_educations", "candidate_id", ids, [], educations.length);
  await chunked("candidate_experiences (source person)", "candidate_experiences", "candidate_id", ids, [["source", "eq", "person"]], jobs.length);
  await chunked("candidate_identities", "candidate_identities", "candidate_id", ids, [], identities.length);
  await chunked("identity_conflicts", "identity_conflicts", "id", [...conflicts.keys()], [], conflicts.size);
  await chunked("candidate_profile_state", "candidate_profile_state", "candidate_id", ids, [], state.length);
  await chunked("candidate_sources", "candidate_sources", "candidate_id", ids, [], sources.length);

  // Companies and schools the writer made that nothing points at any more. In a dry run the
  // trial's own rows still exist, so "still used" leaves out the rows this undo would delete.
  const jobIds = new Set(jobs.map((j) => j.id));
  const eduIds = new Set(educations.map((e) => e.id));
  const writerCompanies = (await site.select("companies", { columns: "id", filters: [["created_from", "eq", "person_writer"]], order: "id.asc" })).map((c) => c.id);
  const usedCompanies = new Set();
  for (const r of await selectIn(site, "candidate_experiences", "company_id", writerCompanies, { columns: "id,company_id", order: "id.asc" })) if (!jobIds.has(r.id)) usedCompanies.add(r.company_id);
  for (const c of await referenced(site, "schools", "company_id", writerCompanies)) usedCompanies.add(c);
  for (const c of await referenced(site, "candidates", "current_company_id", writerCompanies)) usedCompanies.add(c);
  for (const c of await referenced(site, "companies", "merged_into", writerCompanies)) usedCompanies.add(c);
  const writerSchools = (await site.select("schools", { columns: "id", filters: [["created_from", "eq", "person_writer"]], order: "id.asc" })).map((s) => s.id);
  const usedSchools = new Set();
  for (const r of await selectIn(site, "candidate_educations", "school_id", writerSchools, { columns: "id,school_id", order: "id.asc" })) if (!eduIds.has(r.id)) usedSchools.add(r.school_id);
  for (const s of await referenced(site, "schools", "merged_into", writerSchools)) usedSchools.add(s);
  const orphanSchools = writerSchools.filter((s) => !usedSchools.has(s));
  const orphanCompanies = writerCompanies.filter((c) => !usedCompanies.has(c));
  // Schools first: a school can point at a company.
  await chunked("schools (created by the writer, unused)", "schools", "id", orphanSchools, [["created_from", "eq", "person_writer"]], orphanSchools.length);
  await chunked("companies (created by the writer, unused)", "companies", "id", orphanCompanies, [["created_from", "eq", "person_writer"]], orphanCompanies.length);
  const kept = { companies: writerCompanies.length - orphanCompanies.length, schools: writerSchools.length - orphanSchools.length };

  const skillsStillUsed = apply ? await referenced(site, "candidate_skills", "skill_id", skillIds) : new Set();
  const unusedSkills = apply ? skillIds.filter((s) => !skillsStillUsed.has(s)).length : null;
  return { steps: out, kept, unusedSkills };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const apply = argv.includes("--apply") || falsy(process.env.DRY_RUN);
  const ids = parseIds({ list: opt("--ids") ?? process.env.TRIAL_IDS, file: opt("--file") ?? process.env.TRIAL_IDS_FILE });
  const site = await openSite();
  try {
    console.log(`person trial undo: ${ids.length} ids, website ${site.kind}, ${apply ? "DELETING" : "dry run (DRY_RUN=0 or --apply to delete)"}`);
    const { steps, kept, unusedSkills } = await undo(site, ids, { apply });
    for (const [label, n] of steps) console.log(`${apply ? "deleted" : "would delete"} ${String(n).padStart(6)}  ${label}`);
    console.log(`writer companies still used by other rows: ${kept.companies}; writer schools still used: ${kept.schools}`);
    if (unusedSkills !== null) console.log(`skills the trial people used that nobody uses now: ${unusedSkills} (kept: the dictionary is shared)`);
    console.log("the candidates rows were not touched");
    return 0;
  } finally {
    await site.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((err) => { console.error(redact(err instanceof Error ? err.message : err)); process.exit(1); });
}

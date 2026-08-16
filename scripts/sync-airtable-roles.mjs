#!/usr/bin/env node
// Airtable roles mirror + application links. Two jobs:
//  1. Upsert the "Roles" table from data/roles.json (create/update by Job ID;
//     roles that dropped out get Status=closed — records are never deleted).
//  2. Refresh every Website Applications row's linked columns:
//       Applied Roles         = what they chose (role_ids)
//       Matched Roles Linked  = evidence matches (apply suggestions + verdicts)
//       Stretch Matches       = inference-channel pairings
// Runs in the nightly workflow after the refresh worker, and as the last leg
// of the roles-update chain (npm run sync-roles). Safe to run any time.
import fs from "node:fs";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AT_TOKEN = process.env.AIRTABLE_API_TOKEN;
const BASE = process.env.AIRTABLE_BASE_ID;
if (!SUPABASE_URL || !KEY || !AT_TOKEN || !BASE) throw new Error("Supabase + Airtable creds required");

const SITE = "https://www.transformertalent.com";
const roles = JSON.parse(fs.readFileSync(new URL("../data/roles.json", import.meta.url)));

const AT = { Authorization: `Bearer ${AT_TOKEN}`, "Content-Type": "application/json" };
async function at(path, init = {}) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, { ...init, headers: { ...AT, ...init.headers } });
  if (!res.ok) throw new Error(`airtable ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function atList(table, fields = []) {
  const out = [];
  let offset = "";
  do {
    const q = [fields.map((f) => `fields%5B%5D=${encodeURIComponent(f)}`).join("&"), offset && `offset=${offset}`]
      .filter(Boolean)
      .join("&");
    const page = await at(`${table}?${q}`);
    out.push(...page.records);
    offset = page.offset || "";
  } while (offset);
  return out;
}
const SB = { apikey: KEY, Authorization: `Bearer ${KEY}` };
async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB });
  if (!res.ok) throw new Error(`supabase ${path.split("?")[0]} ${res.status}`);
  return res.json();
}

const slug = (r) =>
  `${r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)}-${r.jobId}`;

// ---- 1. Upsert Roles ----
const existing = await atList("Roles", ["Job ID", "Status"]);
const byJobId = new Map(existing.map((r) => [r.fields["Job ID"], r]));
const wanted = new Set(roles.map((r) => r.jobId));

const toCreate = [];
const toUpdate = [];
for (const r of roles) {
  const fields = {
    Role: `${r.title} (#${r.jobId})`,
    "Job ID": r.jobId,
    Title: r.title,
    Salary: r.salary || "",
    Locations: (r.locations || []).join(", "),
    Workplace: r.workplace || "",
    Visa: r.visa || "",
    Years: r.yoe || "",
    "Role Type": r.roleType || "",
    "Tech Stack": r.techStack || "",
    Status: "open",
    "Site URL": `${SITE}/roles/${slug(r)}`,
  };
  const ex = byJobId.get(r.jobId);
  if (!ex) toCreate.push({ fields });
  else toUpdate.push({ id: ex.id, fields });
}
const toClose = existing.filter((e) => !wanted.has(e.fields["Job ID"]) && e.fields["Status"] !== "closed");

for (let i = 0; i < toCreate.length; i += 10) {
  await at("Roles", { method: "POST", body: JSON.stringify({ records: toCreate.slice(i, i + 10) }) });
}
for (let i = 0; i < toUpdate.length; i += 10) {
  await at("Roles", { method: "PATCH", body: JSON.stringify({ records: toUpdate.slice(i, i + 10) }) });
}
for (let i = 0; i < toClose.length; i += 10) {
  await at("Roles", {
    method: "PATCH",
    body: JSON.stringify({ records: toClose.slice(i, i + 10).map((e) => ({ id: e.id, fields: { Status: "closed" } })) }),
  });
}
console.log(`Roles: ${toCreate.length} created, ${toUpdate.length} updated, ${toClose.length} closed`);

// ---- 2. Application links ----
const roleRecords = await atList("Roles", ["Job ID"]);
const recOf = new Map(roleRecords.map((r) => [r.fields["Job ID"], r.id]));

const apps = await sb("website_applications?select=id,candidate_id,role_ids,matched_role_ids,preferred_locations");
const appRecords = await atList("Website%20Applications", ["Application ID"]);
const appRecOf = new Map(appRecords.map((r) => [r.fields["Application ID"], r.id]));

let linked = 0;
for (const app of apps) {
  const recId = appRecOf.get(app.id);
  if (!recId) continue;
  const applied = new Set(app.role_ids || []);
  // Apply-time suggestions already survived gates + screening — endorsements.
  const matched = new Set(app.matched_role_ids || []);
  const stretch = new Set();
  let screenedTotal = 0;
  let qualifiedCount = 0;
  const fitLines = [];
  if (app.candidate_id) {
    const rows = await sb(
      `match_verdicts?candidate_id=eq.${app.candidate_id}&select=source,verdict,created_at,org_roles(external_id)&order=created_at.desc`
    );
    // Only the NEWEST verdict per role counts — older generations are history.
    const newest = new Map();
    for (const v of rows) {
      const id = v.org_roles?.external_id;
      if (id && !newest.has(id)) newest.set(id, v);
    }
    const verdicts = [...newest.values()];
    screenedTotal = verdicts.length;
    qualifiedCount = verdicts.filter((v) => v.verdict?.qualified).length;
    for (const v of verdicts) {
      const id = v.org_roles?.external_id;
      if (!id) continue;
      // Applied roles: surface the scorecard as hiring guidance.
      if (applied.has(id)) {
        const sc = v.verdict?.scorecard;
        if (sc) {
          fitLines.push(
            `#${id} ${sc.tier} — ${sc.reason}` +
              (sc.gaps?.length ? `\n  gaps: ${sc.gaps.slice(0, 4).join("; ")}` : "")
          );
        }
        continue;
      }
      // Endorsement-only columns: screened-but-rejected stays in Supabase.
      if (!v.verdict?.qualified) continue;
      if (v.source === "stretch") stretch.add(id);
      else matched.add(id);
    }
  }
  for (const id of matched) if (stretch.has(id)) stretch.delete(id);
  const links = (set) => [...set].map((id) => recOf.get(id)).filter(Boolean);
  await at(`Website%20Applications/${recId}`, {
    method: "PATCH",
    body: JSON.stringify({
      fields: {
        "Applied Roles": links(applied),
        "Matched Roles Linked": links(matched),
        "Stretch Matches": links(stretch),
        Screened: screenedTotal ? `${screenedTotal} screened (${qualifiedCount} qualified)` : "",
        "Preferred Locations": (app.preferred_locations || []).join(", "),
        ...(fitLines.length ? { "Application Fit": fitLines.join("\n\n") } : {}),
      },
    }),
  });
  linked++;
}
console.log(`Applications: ${linked} rows linked`);

#!/usr/bin/env node
// One-off repair for rows written before the tenancy fixes (2026-09-24).
//
//   node scripts/tenancy/repair-existing.mjs            dry run: counts only
//   node scripts/tenancy/repair-existing.mjs --apply    make the changes
//
// 1. Copies of Transformer Talent verdicts that crossed into a client company
//    with a person TT sent (match_verdicts source "referral", and the sent
//    application's screening) are cut down to the client-safe part: the
//    scorecard numbers the tag and reason are computed from. TT's own
//    verdict rows are not touched.
// 2. A client company's own applicants were keyed to TT's pool record for the
//    same LinkedIn profile, and their verdicts stamped with TT's organization.
//    They move to the company's own person key (its first application from
//    that profile), their verdict rows to the company, and the judge's cache
//    and confirmed facts with them. TT's pool records are not touched.
//
// Needs .env.scripts (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). Prints ids
// and counts, never names or contact details.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { svc, TT_SLUG } from "./fixture.mjs";

const APPLY = process.argv.includes("--apply");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The same rule the send uses, from the same source file.
execFileSync("npx", ["--yes", "esbuild@0.28.2", "lib/server/client-reason.ts", "--bundle", "--platform=node",
  "--format=esm", `--alias:@=${root}`, "--outfile=scripts/dist/client-reason.mjs", "--log-level=warning"], { cwd: root, stdio: "inherit" });
const { clientSafeVerdict } = await import(path.join(root, "scripts/dist/client-reason.mjs"));

const patch = (p, body) => svc(p, { method: "PATCH", body: JSON.stringify(body), prefer: "return=minimal" });
// Postgres stores jsonb with its own key order: compare with keys sorted, so
// a rerun after --apply finds nothing left to do.
const canon = (v) =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
  : JSON.stringify(v ?? null);
const [tt] = await svc(`organizations?slug=eq.${TT_SLUG}&select=id`);
if (!tt) throw new Error("Transformer Talent org not found");
console.log(APPLY ? "APPLYING" : "DRY RUN (pass --apply to change rows)");

/* ---- 1. client copies of TT verdicts -------------------------------------- */

const mirrors = await svc(`match_verdicts?source=eq.referral&organization_id=neq.${tt.id}&select=id,verdict`);
let mirrorFix = 0;
for (const m of mirrors) {
  const safe = clientSafeVerdict(m.verdict);
  const next = safe ? { ...safe, job_id: m.verdict?.job_id } : null;
  if (canon(next) === canon(m.verdict)) continue;
  mirrorFix++;
  if (!APPLY) continue;
  if (next) await patch(`match_verdicts?id=eq.${m.id}`, { verdict: next, model: null });
  else await svc(`match_verdicts?id=eq.${m.id}`, { method: "DELETE", prefer: "return=minimal" });
}
console.log(`client copies of TT verdicts: ${mirrors.length} found, ${mirrorFix} cut down to the client-safe part`);

const sent = await svc(`website_applications?source=eq.transformer_talent&organization_id=neq.${tt.id}&select=id,screening`);
let sentFix = 0;
for (const a of sent) {
  const list = Array.isArray(a.screening) ? a.screening : [];
  const next = list.map((v) => {
    const safe = clientSafeVerdict(v);
    return safe ? { ...safe, job_id: v?.job_id } : null;
  }).filter(Boolean);
  const value = next.length ? next : null;
  if (canon(value) === canon(a.screening ?? null)) continue;
  sentFix++;
  if (APPLY) await patch(`website_applications?id=eq.${a.id}`, { screening: value });
}
console.log(`sent applications' screening: ${sent.length} found, ${sentFix} cut down`);

/* ---- 2. client applicants keyed to TT's pool --------------------------------- */

const apps = await svc(
  `website_applications?organization_id=neq.${tt.id}&candidate_id=not.is.null&or=(source.is.null,source.neq.transformer_talent)` +
    `&select=id,organization_id,candidate_id,linkedin_username,created_at&order=created_at.asc`
);
let moved = 0;
let verdictsMoved = 0;
let cacheMoved = 0;
let factsMoved = 0;
for (const a of apps) {
  if (a.candidate_id === a.id) continue;
  // The company's first application from this LinkedIn profile carries the
  // person (the same rule as tenantPersonId in lib/server/applicants.ts).
  const [first] = a.linkedin_username
    ? await svc(
        `website_applications?organization_id=eq.${a.organization_id}&linkedin_username=eq.${encodeURIComponent(a.linkedin_username)}` +
          `&or=(source.is.null,source.neq.transformer_talent)&select=id&order=created_at.asc&limit=1`
      )
    : [];
  const person = first?.id ?? a.id;
  if (a.candidate_id === person) continue;
  const oldId = a.candidate_id;
  const roles = (await svc(`org_roles?organization_id=eq.${a.organization_id}&select=id`)).map((r) => r.id);
  const onRoles = roles.length ? `&org_role_id=in.(${roles.join(",")})` : "&org_role_id=is.null";
  const verdicts = await svc(`match_verdicts?candidate_id=eq.${oldId}${onRoles}&source=neq.referral&select=id`);
  const cache = await svc(`verdict_cache?candidate_key=eq.cand_${oldId}${onRoles}&select=id`);
  const facts = await svc(`candidate_profiles?organization_id=eq.${a.organization_id}&candidate_key=eq.cand_${oldId}&select=candidate_key`);
  const factsTaken = await svc(`candidate_profiles?organization_id=eq.${a.organization_id}&candidate_key=eq.cand_${person}&select=candidate_key`);
  console.log(`  application ${a.id}: person key ${person === a.id ? "itself" : person}; ${verdicts.length} verdict row(s), ${cache.length} cached, ${facts.length} fact set(s)`);
  moved++;
  verdictsMoved += verdicts.length;
  cacheMoved += cache.length;
  if (!APPLY) continue;
  for (const v of verdicts) await patch(`match_verdicts?id=eq.${v.id}`, { candidate_id: person, organization_id: a.organization_id });
  for (const c of cache) await patch(`verdict_cache?id=eq.${c.id}`, { candidate_key: `cand_${person}`, organization_id: a.organization_id });
  if (facts.length && !factsTaken.length) {
    await patch(`candidate_profiles?organization_id=eq.${a.organization_id}&candidate_key=eq.cand_${oldId}`, { candidate_key: `cand_${person}` });
    factsMoved++;
  }
  await patch(`website_applications?id=eq.${a.id}`, { candidate_id: person });
}
console.log(`client applicants re-keyed: ${moved} (verdict rows ${verdictsMoved}, cache ${cacheMoved}, fact sets ${factsMoved})`);

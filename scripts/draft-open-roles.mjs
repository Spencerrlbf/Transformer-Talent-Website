#!/usr/bin/env node
// Drafts a scorecard for every open role that has none, the way the job page
// does the first time a role is opened (ensureRoleCard), so the pool judge has
// rows to judge against for every open role, not only the ones a recruiter
// has opened. A role that already has a card is never touched: the save is
// "only if empty". About three cents per role.
//
// Modes:
//   node scripts/draft-open-roles.mjs                 draft every open role without a card
//   LIMIT=5 node scripts/draft-open-roles.mjs         the first five only (by external id)
//   DRY_RUN=1 node scripts/draft-open-roles.mjs       list what would be drafted, draft nothing
//   FROM_ID=137 SHARD=0/4 node scripts/draft-open-roles.mjs   new roles only, one quarter
//
// Shared logic comes from the compiled website library: run
// `node scripts/build-worker-lib.mjs` first (the GitHub Action does).
import fs from "node:fs";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const { ensureRoleCard, ROLE_CARD_COLS, roleDraftInput, canDraft } = await import("./dist/worker-lib.mjs");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
const DRY_RUN = !!process.env.DRY_RUN;
if (!process.env.OPENAI_API_KEY && !DRY_RUN) throw new Error("OPENAI_API_KEY required");
const LIMIT = Math.max(0, parseInt(process.env.LIMIT || "0", 10) || 0);
const CONCURRENCY = 3;

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]} ${res.status}: ${await res.text()}`);
  return res.json();
}

const [org] = await rest("organizations?slug=eq.transformer-talent&select=id");
if (!org) throw new Error("organization not found");

// Open roles with no card, oldest external id first, so a re-run after a
// stop carries on where it left off.
let roles = await rest(
  `org_roles?organization_id=eq.${org.id}&status=eq.open&scorecard=is.null&select=${ROLE_CARD_COLS},external_id&order=external_id.asc`
);
// FROM_ID=137 keeps only roles whose job id is at least that number (a batch of
// newly added roles); SHARD=i/n splits the list so n processes can run side by
// side without overlapping (SHARD=0/4, 1/4, 2/4, 3/4).
const FROM_ID = parseInt(process.env.FROM_ID || "0", 10) || 0;
const [SHARD_I, SHARD_N] = (process.env.SHARD || "0/1").split("/").map((n) => parseInt(n, 10));
roles = roles
  .filter((r) => !FROM_ID || parseInt(r.external_id, 10) >= FROM_ID)
  .filter((_, i) => i % SHARD_N === SHARD_I);
if (LIMIT) roles = roles.slice(0, LIMIT);
console.log(`${roles.length} open role(s) without a scorecard${LIMIT ? ` (limit ${LIMIT})` : ""}${DRY_RUN ? ", dry run" : ""}`);

const kinds = (card) => card.criteria.map((c) => (/^\d+\+ years/.test(c.label) ? "y" : c.ladder ? "j" : "t")).join("");
const tally = { drafted: 0, skipped: 0, failed: 0 };
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, roles.length) }, async () => {
    while (next < roles.length) {
      const role = roles[next++];
      const tag = `#${role.external_id} ${role.title}`;
      if (!canDraft(roleDraftInput(role))) {
        tally.skipped++;
        console.log(`  skip ${tag}: nothing written about the role to draft from`);
        continue;
      }
      if (DRY_RUN) {
        tally.drafted++;
        console.log(`  would draft ${tag}`);
        continue;
      }
      try {
        const { card } = await ensureRoleCard(role, { timeoutMs: 40_000 });
        if (!card) {
          tally.failed++;
          console.log(`  FAILED ${tag}: no draft came back`);
          continue;
        }
        tally.drafted++;
        console.log(`  drafted ${tag}: ${card.criteria.length} rows (${kinds(card)})${card.draftNotes?.[0] ? ` | ${card.draftNotes[0].slice(0, 90)}` : ""}`);
      } catch (err) {
        tally.failed++;
        console.log(`  FAILED ${tag}: ${err instanceof Error ? err.message : err}`);
      }
    }
  })
);
console.log(`done: ${tally.drafted} ${DRY_RUN ? "would be drafted" : "drafted"}, ${tally.skipped} skipped, ${tally.failed} failed`);

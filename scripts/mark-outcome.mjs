#!/usr/bin/env node
// Recommendation outcome tracking — the ground truth for tuning scoring
// weights and, later, proving recommendation quality with real numbers.
//
//   node scripts/mark-outcome.mjs list [n]          recent verdicts
//   node scripts/mark-outcome.mjs <id> accepted     a human acted on it
//   node scripts/mark-outcome.mjs <id> rejected     surfaced but declined
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
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const [cmd, arg] = process.argv.slice(2);

if (!cmd || cmd === "list") {
  const n = parseInt(arg, 10) || 20;
  const rows = await rest(
    `match_verdicts?select=id,candidate_id,verdict,source,surfaced_count,outcome,created_at,org_roles(external_id,title)&order=created_at.desc&limit=${n}`
  );
  const candIds = [...new Set(rows.map((r) => r.candidate_id))];
  const cands = candIds.length
    ? await rest(`candidates?id=in.(${candIds.join(",")})&select=id,full_name,linkedin_username`)
    : [];
  const nameOf = (id) => {
    const c = cands.find((x) => x.id === id);
    return c?.full_name || c?.linkedin_username || id.slice(0, 8);
  };
  for (const r of rows) {
    console.log(
      [
        r.id.slice(0, 8),
        nameOf(r.candidate_id).padEnd(24).slice(0, 24),
        `#${r.org_roles?.external_id} ${r.org_roles?.title || ""}`.padEnd(40).slice(0, 40),
        r.verdict.qualified ? `fit ${r.verdict.fit_score}` : "not qual",
        r.source === "stretch" ? `STRETCH(${(r.verdict.origin_signal || "").slice(0, 30)})` : r.source,
        `surfaced ${r.surfaced_count}x`,
        r.outcome || "—",
      ].join("  ")
    );
  }
  process.exit(0);
}

if (["accepted", "rejected"].includes(arg)) {
  // uuid columns don't support like — prefix-match client-side.
  const all = await rest(`match_verdicts?select=id&order=created_at.desc&limit=500`);
  const rows = all.filter((r) => r.id.startsWith(cmd.toLowerCase()));
  if (rows.length !== 1) {
    console.error(rows.length ? `ambiguous id prefix (${rows.length} matches)` : "no verdict with that id");
    process.exit(1);
  }
  await rest(`match_verdicts?id=eq.${rows[0].id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ outcome: arg, outcome_at: new Date().toISOString() }),
  });
  console.log(`${rows[0].id} -> ${arg}`);
  process.exit(0);
}

console.error("usage: mark-outcome.mjs list [n] | <id-prefix> accepted|rejected");
process.exit(1);

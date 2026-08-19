#!/usr/bin/env node
// Grant sourcing credits to an org (internal — you charge the client however
// you like, then grant the bundle here).
//
//   node scripts/grant-credits.mjs demo-co 1000 "pilot allocation"
//   node scripts/grant-credits.mjs demo-co -50 "correction"
import fs from "node:fs";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const [slug, creditsArg, ...reasonParts] = process.argv.slice(2);
const credits = parseInt(creditsArg, 10);
if (!slug || !Number.isFinite(credits) || credits === 0) {
  console.error('usage: node scripts/grant-credits.mjs <org-slug> <credits> "<reason>"');
  process.exit(1);
}
const reason = reasonParts.join(" ") || null;

const URL_ = (process.env.SUPABASE_URL || "").trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const rest = async (p, init = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${p}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!r.ok) throw new Error(`${p.split("?")[0]} ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

const [org] = await rest(`organizations?slug=eq.${slug}&select=id,name`);
if (!org) throw new Error(`org ${slug} not found`);

await rest("credit_grants", {
  method: "POST",
  body: JSON.stringify({ organization_id: org.id, credits, reason, created_by: "grant-credits.mjs" }),
  headers: { Prefer: "return=minimal" },
});

const [summary] = await rest(`rpc/org_credit_summary`, {
  method: "POST", body: JSON.stringify({ p_org: org.id }),
});
console.log(`${org.name}: ${credits > 0 ? "+" : ""}${credits} credits${reason ? ` (${reason})` : ""}`);
console.log(`balance: ${summary.balance} (granted ${summary.granted}, spent ${summary.spent}, held ${summary.held}, available ${summary.available})`);

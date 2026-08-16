#!/usr/bin/env node
// Onboard a company + its first dashboard user (run during onboarding calls):
//   node scripts/create-org-member.mjs <org-slug> <email> [--name "Acme AI"] [--link]
// Creates the organization if new, creates/finds the auth user via
// generate_link (idempotent), and upserts the org_members row. --link prints
// a one-time magic sign-in link you can paste to the client directly.
import fs from "node:fs";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const URL_ = (process.env.SUPABASE_URL || "").trim();
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) throw new Error("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [slug, email] = args;
const nameIdx = process.argv.indexOf("--name");
const orgName = nameIdx > -1 ? process.argv[nameIdx + 1] : null;
const wantLink = process.argv.includes("--link");
if (!slug || !email) {
  console.error('usage: create-org-member.mjs <org-slug> <email> [--name "Acme AI"] [--link]');
  process.exit(1);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
async function sb(path, init = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...init.headers } });
  if (!res.ok) throw new Error(`${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// 1. Organization (create if new)
let [org] = await sb(`organizations?slug=eq.${slug}&select=id,name`);
if (!org) {
  if (!orgName) {
    console.error(`org "${slug}" doesn't exist — pass --name "Company Name" to create it`);
    process.exit(1);
  }
  [org] = await sb("organizations", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ slug, name: orgName }),
  });
  console.log(`created organization ${orgName} (${slug})`);
} else {
  console.log(`organization exists: ${org.name} (${slug})`);
}

// 2. Auth user via generate_link — creates the user if missing.
const linkRes = await fetch(`${URL_}/auth/v1/admin/generate_link`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    type: "magiclink",
    email,
    redirect_to: process.env.DASH_REDIRECT || "https://www.transformertalent.com/dashboard",
  }),
});
if (!linkRes.ok) throw new Error(`generate_link ${linkRes.status}: ${(await linkRes.text()).slice(0, 300)}`);
const link = await linkRes.json();
const userId = link.user?.id || link.id;
if (!userId) throw new Error("no user id in generate_link response");
console.log(`auth user: ${email} (${userId})`);

// 3. Membership (idempotent)
const existing = await sb(`org_members?organization_id=eq.${org.id}&user_id=eq.${userId}&select=id`);
if (existing.length) {
  console.log("membership already exists");
} else {
  await sb("org_members", {
    method: "POST",
    body: JSON.stringify({ organization_id: org.id, user_id: userId, email, member_role: "member" }),
  });
  console.log(`added ${email} to ${org.name}`);
}

if (wantLink) console.log(`\none-time sign-in link:\n${link.action_link || link.properties?.action_link}`);

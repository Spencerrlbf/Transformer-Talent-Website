#!/usr/bin/env node
// Nightly sync: reply-ops Airtable Candidates → Supabase candidates pool.
// Read-only against Airtable; reply-ops is never modified. Engaged candidates
// get source='airtable_sync', which the website matcher boosts and badges.
import crypto from "node:crypto";

const {
  AIRTABLE_API_TOKEN,
  AIRTABLE_BASE_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  OPENAI_API_KEY,
} = process.env;

for (const [k, v] of Object.entries({ AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY })) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}

const FIELDS = [
  "Full Name", "Candidate Name", "First Name", "Last Name", "Current Title", "Current Company",
  "LinkedIn URL", "Primary Email", "Education", "Current Status", "Do Not Contact",
];

async function airtableAll() {
  const rows = [];
  let offset;
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    FIELDS.forEach((f) => params.append("fields[]", f));
    if (offset) params.set("offset", offset);
    const res = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Candidates?${params}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_TOKEN}` } }
    );
    if (!res.ok) throw new Error(`airtable ${res.status}: ${await res.text()}`);
    const data = await res.json();
    rows.push(...data.records);
    offset = data.offset;
  } while (offset);
  return rows;
}

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

function normalizeLinkedin(url) {
  if (!url) return null;
  return url.trim().toLowerCase().replace(/\/+$/, "").replace(/^http:/, "https:").replace("://linkedin.com", "://www.linkedin.com") || null;
}

function mapRecord(rec) {
  const f = rec.fields;
  const clean = (s) => (typeof s === "string" ? s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").trim() || null : null);
  const linkedin = normalizeLinkedin(f["LinkedIn URL"]);
  const usernameMatch = linkedin && linkedin.match(/\/in\/([^\/?#]+)/);
  return {
    airtable_id: rec.id,
    linkedin_username: usernameMatch ? decodeURIComponent(usernameMatch[1]) : null,
    full_name: clean(f["Full Name"]) || clean(f["Candidate Name"]) || "Unknown",
    first_name: clean(f["First Name"]),
    last_name: clean(f["Last Name"]),
    current_title: clean(f["Current Title"]),
    current_company: clean(f["Current Company"]),
    linkedin_url: linkedin,
    email: clean(f["Primary Email"]),
    education: clean(f["Education"]),
    status: clean(f["Current Status"]) || "engaged",
    source: "airtable_sync",
  };
}

function hashOf(mapped) {
  return crypto.createHash("sha256").update(JSON.stringify(mapped)).digest("hex").slice(0, 32);
}

async function embedBatch(texts) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts.map((t) => t.slice(0, 8000)) }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${await res.text()}`);
  return (await res.json()).data.map((d) => d.embedding);
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function main() {
  let records = (await airtableAll()).filter((r) => !r.fields["Do Not Contact"]);
  const limit = parseInt(process.env.SYNC_LIMIT || "0", 10);
  if (limit > 0) records = records.slice(0, limit);
  console.log(`airtable: ${records.length} contactable candidates`);

  // Existing rows previously synced (matched by airtable_id).
  const byAirtableId = new Map();
  for (const ids of chunk(records.map((r) => r.id), 100)) {
    const res = await sb(`candidates?airtable_id=in.(${ids.map((i) => `"${i}"`).join(",")})&select=id,airtable_id,airtable_sync_hash,matching_embedding`);
    for (const row of await res.json()) byAirtableId.set(row.airtable_id, row);
  }

  // First-run linkage: existing rows for the same person by linkedin_username
  // (unique-indexed in Supabase, so it is the canonical identity).
  const usernameOf = (url) => {
    const m = url && url.match(/\/in\/([^\/?#]+)/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  };
  const unsynced = records.filter((r) => !byAirtableId.has(r.id));
  const byUsername = new Map();
  const usernames = [...new Set(unsynced.map((r) => usernameOf(normalizeLinkedin(r.fields["LinkedIn URL"]))).filter(Boolean))];
  const SAFE = /^[a-zA-Z0-9\-_.]+$/;
  const safeNames = usernames.filter((u) => SAFE.test(u));
  const oddNames = usernames.filter((u) => !SAFE.test(u));
  for (const batch of chunk(safeNames, 80)) {
    const inList = batch.map((u) => `"${u}"`).join(",");
    const res = await sb(`candidates?linkedin_username=in.(${inList})&select=id,linkedin_username,airtable_id,matching_embedding`);
    for (const row of await res.json()) byUsername.set((row.linkedin_username || "").toLowerCase(), row);
  }
  for (const u of oddNames) {
    const res = await sb(`candidates?linkedin_username=eq.${encodeURIComponent(u)}&select=id,linkedin_username,airtable_id,matching_embedding`);
    for (const row of await res.json()) byUsername.set((row.linkedin_username || "").toLowerCase(), row);
  }

  let updated = 0, inserted = 0, linked = 0, unchanged = 0, skipped = 0;
  const needEmbedding = [];

  for (const rec of records) {
    const mapped = mapRecord(rec);
    const hash = hashOf(mapped);
    const prev = byAirtableId.get(rec.id);

    if (prev) {
      if (prev.airtable_sync_hash === hash) { unchanged++; continue; }
      await sb(`candidates?id=eq.${prev.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...mapped, airtable_sync_hash: hash }),
        headers: { Prefer: "return=minimal" },
      });
      updated++;
      if (!prev.matching_embedding) needEmbedding.push({ id: prev.id, mapped });
      continue;
    }

    const existing = mapped.linkedin_username ? byUsername.get(mapped.linkedin_username.toLowerCase()) : null;
    if (existing && existing.airtable_id && existing.airtable_id !== rec.id) { skipped++; continue; }
    if (existing) {
      // Enrich the existing profile: claim it as engaged, fill identity fields,
      // keep its (richer) LinkedIn-derived embedding and enrichment data.
      await sb(`candidates?id=eq.${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          airtable_id: rec.id,
          source: "airtable_sync",
          status: mapped.status,
          email: mapped.email,
          airtable_sync_hash: hash,
        }),
        headers: { Prefer: "return=minimal" },
      });
      linked++;
      if (!existing.matching_embedding) needEmbedding.push({ id: existing.id, mapped });
      continue;
    }

    if (!mapped.linkedin_username) { skipped++; continue; }
    try {
      const res = await sb("candidates", {
        method: "POST",
        body: JSON.stringify({ ...mapped, airtable_sync_hash: hash }),
        headers: { Prefer: "return=representation" },
      });
      const [row] = await res.json();
      inserted++;
      byUsername.set(mapped.linkedin_username.toLowerCase(), { id: row.id, airtable_id: rec.id, matching_embedding: null });
      needEmbedding.push({ id: row.id, mapped });
    } catch (err) {
      if (!String(err).includes("23505")) throw err;
      // Duplicate username (dupe in Airtable, or row created since our lookup):
      // claim the existing row instead of inserting.
      const res = await sb(`candidates?linkedin_username=eq.${encodeURIComponent(mapped.linkedin_username)}&select=id,airtable_id,matching_embedding`);
      const [row] = await res.json();
      if (!row || (row.airtable_id && row.airtable_id !== rec.id)) { skipped++; continue; }
      await sb(`candidates?id=eq.${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ airtable_id: rec.id, source: "airtable_sync", status: mapped.status, email: mapped.email, airtable_sync_hash: hash }),
        headers: { Prefer: "return=minimal" },
      });
      linked++;
      byUsername.set(mapped.linkedin_username.toLowerCase(), row);
      if (!row.matching_embedding) needEmbedding.push({ id: row.id, mapped });
    }
  }

  console.log(`updated=${updated} linked=${linked} inserted=${inserted} unchanged=${unchanged} skipped_no_linkedin=${skipped}`);

  // Embed rows that have no matching_embedding yet.
  let embedded = 0;
  for (const batch of chunk(needEmbedding, 64)) {
    const texts = batch.map(({ mapped }) =>
      [mapped.current_title, mapped.current_company && `at ${mapped.current_company}`, mapped.education, "actively engaged software candidate"]
        .filter(Boolean)
        .join(". ")
    );
    const vectors = await embedBatch(texts);
    for (let i = 0; i < batch.length; i++) {
      await sb(`candidates?id=eq.${batch[i].id}`, {
        method: "PATCH",
        body: JSON.stringify({ matching_embedding: JSON.stringify(vectors[i]), embedding_type: "airtable_sync" }),
        headers: { Prefer: "return=minimal" },
      });
      embedded++;
    }
  }
  console.log(`embedded=${embedded}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

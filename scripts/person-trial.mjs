#!/usr/bin/env node
// The 50-person trial of the one writer (lib/server/person + save_person,
// migration 072). For each candidate id it reads every stored source (the
// candidates row, candidate_emails, candidate_emails_v2, the Harvest ledger,
// TT applications and, for directory people, the directory's own records),
// builds one PersonDoc per source with the translators from the worker
// bundle, saves them oldest -> newest through save_person, reads the new
// tables back and checks what Spencer set as "done":
//   every job accounted for, every job linked to a company, every known email
//   present, exactly one primary email per person with a usable address,
//   0 errors, a second run changes nothing, and the candidates rows are
//   exactly what they were before (the live site reads only those).
// It prints ids, counts and check results only, never a name, email or phone,
// and exits 1 when any check fails.
//
//   node scripts/person-trial.mjs --ids <id,id,...>   (or --file ids.txt | ids.json, or TRIAL_IDS)
//   DRY_RUN=1          read everything and build the docs; save nothing (the doc checks still run)
//   REPEAT=1           save everything twice; the second pass must be all 'unchanged' and change no row
//   --describe         print the directory's table and column names this script reads, nothing else
//   SKIP_DIRECTORY=1   dry runs only, for testing the reads without the directory: directory people
//                      get no directory doc, and the directory_read check fails so the run cannot pass
//   SUMMARY_FILE=path  also write the summary as JSON (ids, counts and checks only)
//   DETAIL_FILE=path   local runs only: every person's before and after, with personal data, for the
//                      review page. Refused on GitHub Actions.
//
// The website database: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (REST, rpc/save_person), or
// LOCAL_DATABASE_URL (a local Postgres holding the same tables and save_person) for testing.
// The directory: COMMS_DATABASE_URL, opened read-only the way scripts/sync-directory.mjs opens it;
// needed only when a trial person is linked to the directory. Shared code comes from the worker
// bundle: run `node scripts/build-worker-lib.mjs` first (the workflow does).
import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

try {
  const envFile = fs.readFileSync(new URL("../.env.scripts", import.meta.url), "utf8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

export const TT_ORG = "801865a7-6533-41d2-9c45-e4a90e6ad51a";
const MAX_IDS = 200;
const PAGE = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IN_CI = process.env.GITHUB_ACTIONS === "true";
/** Which translator a source kind comes from, and the order of docs that share a fetched_at. */
const SOURCE_ORDER = { legacy_import: 0, directory: 1, harvest: 2, application: 3, recruiter: 4 };
const LIB_EXPORTS = ["fromLegacyImport", "fromHarvest", "fromDirectory", "fromApplication", "project"];

// ---------------------------------------------------------------- small helpers

export const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());
export const falsy = (v) => /^(0|false|no|off)$/i.test(String(v ?? "").trim());
const arr = (v) => (Array.isArray(v) ? v : []);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** JSON with object keys sorted at every level: equal values give equal text. */
export function stable(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
    .join(",")}}`;
}
export const hashOf = (v) => sha(stable(v)).slice(0, 32);

export function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/** The spec's email form: lower case, trimmed, mailto: removed. Null when it is not an address. */
export function normEmail(v) {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase().replace(/^mailto:/, "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** A phone's last ten digits (enough to recognise the same number in any format); null for junk. */
export function phoneKey(v) {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = String(v).replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-10) : null;
}

/** Error text safe for a public log: addresses and long digit runs are masked. */
export function redact(s) {
  return String(s)
    .replace(/[^\s@"'()<>,;:]+@[^\s@"'()<>,;:]+/g, "<email>")
    .replace(/\+?\d[\d ().-]{7,}\d/g, (m) => (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(m) ? m : "<digits>"));
}
const why = (err) => redact(err instanceof Error ? err.message : String(err)).slice(0, 300);

export function parseIds({ list, file }) {
  const raw = [];
  if (file) {
    const text = fs.readFileSync(file, "utf8").trim();
    if (text.startsWith("[")) raw.push(...JSON.parse(text).map((x) => (typeof x === "string" ? x : x?.id)));
    else raw.push(...text.split(/[\s,]+/));
  }
  if (list) raw.push(...String(list).split(/[\s,]+/));
  const ids = [...new Set(raw.map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean))];
  const bad = ids.filter((s) => !UUID.test(s));
  if (bad.length) throw new Error(`${bad.length} value(s) are not candidate ids`);
  if (!ids.length) throw new Error("no candidate ids: pass --ids a,b,c, --file ids.txt or TRIAL_IDS");
  if (ids.length > MAX_IDS) throw new Error(`${ids.length} ids: this runner is for trials of at most ${MAX_IDS}`);
  return ids;
}

// ---------------------------------------------------------------- the website database
// Two interchangeable layers with one interface (select / rpc / remove / end):
// PostgREST with the service key in production, a pg connection for local tests.
// Filters are [column, op, value] with op eq | neq | in | ov | is_null | not_null.

const NAME = /^[a-z_][a-z0-9_]*$/;
const name = (n) => {
  if (!NAME.test(n)) throw new Error(`unexpected identifier ${JSON.stringify(n)}`);
  return n;
};
const columnsOf = (c) => (c === "*" ? c : c.split(",").map((x) => name(x.trim())).join(","));
const orderOf = (o) => o.split(",").map((part) => {
  const [col, dir = "asc"] = part.split(".");
  if (!["asc", "desc"].includes(dir)) throw new Error(`unexpected order ${part}`);
  return [name(col), dir];
});

function restFilter([col, op, val]) {
  const c = name(col);
  const list = (vals) => vals.map((v) => `"${String(v).replace(/["\\]/g, "")}"`).join(",");
  switch (op) {
    case "eq": return `${c}=eq.${encodeURIComponent(val)}`;
    case "neq": return `${c}=neq.${encodeURIComponent(val)}`;
    case "in": return `${c}=in.${encodeURIComponent(`(${list(val)})`)}`;
    case "ov": return `${c}=ov.${encodeURIComponent(`{${list(val)}}`)}`;
    case "is_null": return `${c}=is.null`;
    case "not_null": return `${c}=not.is.null`;
    default: throw new Error(`unknown filter ${op}`);
  }
}

function sqlFilter([col, op, val], params) {
  const c = `t.${name(col)}`;
  const p = () => { params.push(val); return `$${params.length}`; };
  switch (op) {
    case "eq": return `${c} = ${p()}`;
    case "neq": return `${c} <> ${p()}`;
    case "in": return `${c} = any(${p()})`;
    case "ov": return `${c} && ${p()}`;
    case "is_null": return `${c} is null`;
    case "not_null": return `${c} is not null`;
    default: throw new Error(`unknown filter ${op}`);
  }
}

export function restSite(url, key) {
  const base = `${url.trim().replace(/\/+$/, "")}/rest/v1/`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  async function request(path, init = {}) {
    let res;
    try {
      res = await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    } catch (err) {
      throw new Error(`${init.method || "GET"} ${path.split("?")[0]}: ${err?.cause?.message || err?.message || err}`);
    }
    if (!res.ok) {
      // PostgREST's "details" can quote the failing row, which is personal data: never logged.
      const raw = await res.text();
      let msg = raw.slice(0, 200);
      try { const j = JSON.parse(raw); msg = [j.code, j.message, j.hint].filter(Boolean).join(" | "); } catch {}
      throw new Error(`${init.method || "GET"} ${path.split("?")[0]} ${res.status}: ${msg}`);
    }
    return res;
  }
  const json = async (res) => { const t = await res.text(); return t ? JSON.parse(t) : null; };
  return {
    kind: "rest",
    async select(table, { columns = "*", filters = [], order }) {
      const q = [`select=${columnsOf(columns)}`, ...filters.map(restFilter), `order=${orderOf(order).map(([c, d]) => `${c}.${d}`).join(",")}`].join("&");
      const out = [];
      for (let offset = 0; ; offset += PAGE) {
        const rows = await json(await request(`${name(table)}?${q}&limit=${PAGE}&offset=${offset}`));
        out.push(...rows);
        if (rows.length < PAGE) return out;
      }
    },
    async rpc(fn, args) {
      return json(await request(`rpc/${name(fn)}`, { method: "POST", body: JSON.stringify(args) }));
    },
    async remove(table, filters) {
      if (!filters.length) throw new Error("refusing a delete without a filter");
      const res = await request(`${name(table)}?${filters.map(restFilter).join("&")}`, { method: "DELETE", headers: { Prefer: "return=minimal, count=exact" } });
      const m = (res.headers.get("content-range") || "").match(/\/(\d+)$/);
      return m ? Number(m[1]) : 0;
    },
    async end() {},
  };
}

export async function pgSite(url) {
  const { default: pg } = await import("pg");
  const db = new pg.Client({ connectionString: url, application_name: "tt-person-trial-local" });
  await db.connect();
  const where = (filters, params) => (filters.length ? ` where ${filters.map((f) => sqlFilter(f, params)).join(" and ")}` : "");
  return {
    kind: "pg",
    // Whole rows as Postgres's own JSON (full timestamp precision), like REST's select=*.
    async select(table, { filters = [], order }) {
      const params = [];
      const sql = `select to_jsonb(t) as j from public.${name(table)} t${where(filters, params)} order by ${orderOf(order).map(([c, d]) => `t.${c} ${d}`).join(", ")}`;
      return (await db.query(sql, params)).rows.map((r) => r.j);
    },
    async rpc(fn, args) {
      const keys = Object.keys(args);
      const sql = `select public.${name(fn)}(${keys.map((k, i) => `${name(k)} => $${i + 1}`).join(", ")}) as r`;
      const { rows } = await db.query(sql, keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k])));
      return rows[0].r;
    },
    async remove(table, filters) {
      if (!filters.length) throw new Error("refusing a delete without a filter");
      const params = [];
      return (await db.query(`delete from public.${name(table)} t${where(filters, params)}`, params)).rowCount;
    },
    async end() { await db.end(); },
  };
}

export async function openSite() {
  const { LOCAL_DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (LOCAL_DATABASE_URL) return pgSite(LOCAL_DATABASE_URL);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or LOCAL_DATABASE_URL for a local test)");
  return restSite(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

/** select with a long `in` list split into chunks (URL length); rows in chunk order. */
export async function selectIn(site, table, col, values, { columns = "*", filters = [], order, chunk = 40 } = {}) {
  const out = [];
  const uniq = [...new Set(values.filter((v) => v !== null && v !== undefined))];
  for (let i = 0; i < uniq.length; i += chunk) {
    out.push(...(await site.select(table, { columns, filters: [[col, "in", uniq.slice(i, i + chunk)], ...filters], order })));
  }
  return out;
}

// ---------------------------------------------------------------- the directory (read-only)
// The directory's tables, from the reply-ops code (confirm on the live database with --describe):
//   comms.emails: one row per address per contact: id, workspace_id, contact_id (= comms.contacts.id),
//     normalized (lower case), original_value, classification ('personal' | 'business' | 'academic' |
//     'unknown', from the domain) and verification jsonb: status ('Verified' | 'Risky' | 'Failed' |
//     'Unavailable' | 'Unknown' | 'Unverified' | 'Bounced' | 'Replied', or an Airtable value), primary
//     (the directory's own primary), can_use, source, checked_at, provider, provider_result, bounced_at.
//     Unique (workspace_id, contact_id, normalized).
//   Phones have no table: comms.profile_facts rows with field 'phone' (value jsonb text, provenance
//     'source' | 'manual', recorded_at). Any comms table named like *phone* with a contact_id is read too.
//   board.candidates (a view): contact_id = comms.contacts.id = candidates.directory_contact_id;
//     primary_email = the address marked primary, else a Verified one, else the first; email_status is
//     that address's check.
//   Jobs and schools: comms.contact_experiences / comms.contact_educations (superseded_at null = current);
//   the Harvest header comms.harvest_profiles (fetched_at); its raw JSON in comms.source_versions.

/** What the runner reads from the directory; a missing column stops the run (fail closed). */
export const COMMS_NEEDS = {
  "board.candidates": ["contact_id", "primary_email"],
  "comms.harvest_profiles": ["contact_id", "fetched_at"],
  "comms.contact_experiences": ["contact_id", "superseded_at", "sort_order"],
  "comms.contact_educations": ["contact_id", "superseded_at", "sort_order"],
  "comms.emails": ["contact_id", "normalized", "original_value", "classification", "verification"],
  "comms.profile_facts": ["contact_id", "field", "value", "recorded_at"],
};
/** Read when present: the raw Harvest JSON behind comms.harvest_profiles (it carries the LinkedIn account id). */
const COMMS_OPTIONAL = { "comms.source_versions": ["id", "payload", "captured_at"] };

export async function openComms(url) {
  const { default: pg } = await import("pg");
  // As in sync-directory.mjs: the string may name a CA file from another
  // machine, so TLS is on without that check. A local test database has no TLS.
  const dsn = new URL(url);
  for (const k of ["sslrootcert", "sslcert", "sslkey", "sslmode"]) dsn.searchParams.delete(k);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(dsn.hostname);
  const db = new pg.Client({ connectionString: dsn.toString(), ssl: local ? false : { rejectUnauthorized: false }, application_name: "tt-website-person-trial", statement_timeout: 120_000 });
  await db.connect();
  await db.query("set default_transaction_read_only = on");
  return db;
}

/** Table -> column names for everything the runner reads, plus any directory table about
 *  emails, phones, facts or identifiers (so a phone table added later shows up). Names only. */
export async function commsColumns(db) {
  const wanted = Object.keys({ ...COMMS_NEEDS, ...COMMS_OPTIONAL });
  const { rows } = await db.query(
    `select table_schema, table_name, column_name from information_schema.columns
      where table_schema in ('comms', 'board')
        and (table_schema || '.' || table_name = any($1) or table_name ~ '(email|phone|fact|identifier)')
      order by table_schema, table_name, ordinal_position`,
    [wanted]
  );
  const cols = new Map();
  for (const r of rows) {
    const k = `${r.table_schema}.${r.table_name}`;
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k).push(r.column_name);
  }
  return cols;
}

const phoneTablesOf = (cols) => [...cols.keys()].filter((k) => /^comms\.[a-z_]*phone[a-z_]*$/.test(k) && cols.get(k).includes("contact_id"));

export function missingComms(cols) {
  return Object.entries(COMMS_NEEDS).flatMap(([t, cs]) => cs.filter((c) => !(cols.get(t) || []).includes(c)).map((c) => `${t}.${c}`));
}

/** Everything the directory holds for these contacts, grouped by contact id. Read-only. */
export async function readDirectory(db, contactIds, cols) {
  const missing = missingComms(cols);
  if (missing.length) throw new Error(`the directory has no ${missing.join(", ")}; run with --describe and update the runner`);
  const q = async (sql, params = [contactIds]) => (await db.query(sql, params)).rows;
  const board = await q("select * from board.candidates where contact_id = any($1::uuid[])");
  const harvest = await q("select * from comms.harvest_profiles where contact_id = any($1::uuid[])");
  const exps = await q("select * from comms.contact_experiences where contact_id = any($1::uuid[]) and superseded_at is null order by contact_id, sort_order");
  const edus = await q("select * from comms.contact_educations where contact_id = any($1::uuid[]) and superseded_at is null order by contact_id, sort_order");
  const emails = await q("select * from comms.emails where contact_id = any($1::uuid[]) order by contact_id, normalized");
  const phones = await q("select f.*, f.value #>> '{}' as value_text, 'comms.profile_facts' as from_table from comms.profile_facts f where f.contact_id = any($1::uuid[]) and f.field = 'phone' order by f.contact_id, f.recorded_at, f.id");
  for (const t of phoneTablesOf(cols)) phones.push(...(await q(`select p.*, '${t}' as from_table from ${t} p where p.contact_id = any($1::uuid[])`)));
  const versionIds = cols.get("comms.harvest_profiles")?.includes("source_version_id") ? harvest.map((h) => h.source_version_id).filter(Boolean) : [];
  const versions = versionIds.length && cols.has("comms.source_versions")
    ? await q("select id, captured_at, payload from comms.source_versions where id = any($1::uuid[])", [versionIds])
    : [];
  const versionBy = new Map(versions.map((v) => [v.id, v]));
  // The raw Harvest JSON rides along as harvestRow.raw (harvest_profiles dropped its own raw column).
  const harvestBy = new Map(harvest.map((h) => [h.contact_id, { ...h, raw: versionBy.get(h.source_version_id)?.payload ?? null, raw_captured_at: versionBy.get(h.source_version_id)?.captured_at ?? null }]));
  const boardBy = new Map(board.map((b) => [b.contact_id, b]));
  const [expsBy, edusBy, emailsBy, phonesBy] = [exps, edus, emails, phones].map((rs) => groupBy(rs, "contact_id"));
  const out = new Map();
  for (const cid of contactIds) {
    if (!boardBy.has(cid)) continue;
    out.set(cid, {
      board: boardBy.get(cid),
      harvest: harvestBy.get(cid) ?? null,
      exps: expsBy.get(cid) ?? [],
      edus: edusBy.get(cid) ?? [],
      emails: emailsBy.get(cid) ?? [],
      phones: phonesBy.get(cid) ?? [],
    });
  }
  return out;
}

async function describe() {
  if (!process.env.COMMS_DATABASE_URL) throw new Error("Missing env: COMMS_DATABASE_URL");
  const db = await openComms(process.env.COMMS_DATABASE_URL);
  try {
    const cols = await commsColumns(db);
    console.log("directory tables and columns (names only):");
    for (const [t, cs] of cols) console.log(`  ${t}: ${cs.join(", ")}`);
    const phoneTables = phoneTablesOf(cols);
    console.log(`phones are read from comms.profile_facts (field 'phone')${phoneTables.length ? ` and ${phoneTables.join(", ")}` : ""}`);
    const missing = missingComms(cols);
    console.log(missing.length ? `MISSING (the trial would stop): ${missing.join(", ")}` : "every column the trial reads is present");
    return missing.length ? 1 : 0;
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------- reading the sources

/** Full candidates rows, and a hash of each (the "live site untouched" proof). */
async function candidatesRows(site, ids) {
  const rows = await selectIn(site, "candidates", "id", ids, { order: "id.asc", chunk: 10 });
  return new Map(rows.map((r) => [r.id, r]));
}
const hashRows = (rows) => new Map([...rows].map(([id, r]) => [id, hashOf(r)]));

/** candidate_experiences rows from every other writer (syncExperiences): they must not move. */
async function otherExperienceHashes(site, ids) {
  const rows = await selectIn(site, "candidate_experiences", "candidate_id", ids, { filters: [["source", "neq", "person"]], order: "candidate_id.asc,id.asc" });
  const by = groupBy(rows, "candidate_id");
  return new Map(ids.map((id) => [id, hashOf(by.get(id) ?? [])]));
}

async function readSources(site, ids, rows) {
  const legacy = await selectIn(site, "candidate_emails", "candidate_id", ids, { order: "id.asc" });
  const v2 = await selectIn(site, "candidate_emails_v2", "candidate_id", ids, { order: "id.asc" });
  const ledger = await selectIn(site, "candidate_enrichments", "candidate_id", ids, {
    columns: "id,organization_id,candidate_id,linkedin_username,provider,operation,status,created_at,raw_payload",
    filters: [["organization_id", "eq", TT_ORG], ["provider", "eq", "harvest"], ["status", "eq", "ok"]],
    order: "created_at.asc,id.asc",
    chunk: 10,
  });
  const apps = await selectIn(site, "website_applications", "candidate_id", ids, { filters: [["organization_id", "eq", TT_ORG]], order: "created_at.asc,id.asc" });
  const L = groupBy(legacy, "candidate_id");
  const V = groupBy(v2, "candidate_id");
  const H = groupBy(ledger, "candidate_id");
  const A = groupBy(apps, "candidate_id");
  return new Map(ids.filter((id) => rows.has(id)).map((id) => [id, { row: rows.get(id), legacy: L.get(id) ?? [], v2: V.get(id) ?? [], ledger: H.get(id) ?? [], apps: A.get(id) ?? [], dir: null }]));
}

/** The application made the person when the pool row appeared with it (the apply pipeline creates
 *  the row seconds after the application); an older row was only linked. */
export function createdThePerson(app, row) {
  const a = Date.parse(app?.created_at);
  const c = Date.parse(row?.created_at);
  return Number.isFinite(a) && Number.isFinite(c) && c >= a - 5_000 && c - a <= 15 * 60_000;
}

/** Every email any source holds for the person, found independently of the translators. */
export function knownEmails({ row, legacy, v2, ledger, apps, dir }) {
  const out = new Map();
  const add = (v, from) => {
    const e = normEmail(typeof v === "string" ? v : v?.email ?? v?.address ?? v?.value);
    if (!e) return;
    if (!out.has(e)) out.set(e, new Set());
    out.get(e).add(from);
  };
  for (const e of legacy) add(e.email_address, "candidate_emails");
  for (const e of v2) { add(e.email_normalized, "candidate_emails_v2"); add(e.email_raw, "candidate_emails_v2"); }
  add(row.email, "candidates.email");
  if (row.contact && typeof row.contact === "object") {
    add(row.contact.email, "candidates.contact");
    for (const x of arr(row.contact.otherEmails)) add(x, "candidates.contact");
  }
  add(row.linkedin_data?.data?.basic_info?.email, "raw_import");
  for (const l of ledger) for (const x of arr(l.raw_payload?.emails)) add(x, "harvest");
  if (dir) {
    for (const e of dir.emails) add(e.normalized ?? e.original_value, "directory");
    add(dir.board?.primary_email, "directory");
    for (const x of arr(dir.harvest?.emails)) add(x, "directory_harvest");
  }
  for (const a of apps) {
    add(a.email, "application");
    if (a.contact && typeof a.contact === "object") {
      add(a.contact.email, "application");
      for (const x of arr(a.contact.otherEmails)) add(x, "application");
    }
  }
  return out;
}

/** Every phone number any source holds (junk with fewer than 7 digits is not a phone). */
export function knownPhones({ row, apps, dir }) {
  const out = new Set();
  const add = (v) => { const k = phoneKey(v); if (k) out.add(k); };
  add(row.phone);
  if (row.contact && typeof row.contact === "object") add(row.contact.phone);
  for (const a of apps) if (a.contact && typeof a.contact === "object") add(a.contact.phone);
  if (dir) for (const p of dir.phones) add(p.value_text ?? p.normalized ?? p.value ?? p.phone ?? p.number);
  return out;
}

// ---------------------------------------------------------------- building the docs

const docLabel = (d) => `${d.source?.source ?? "?"}@${String(d.source?.fetched_at ?? "").slice(0, 10) || "?"}`;

async function buildDocs(lib, id, inp) {
  const docs = [];
  const errors = [];
  const add = async (label, fn) => {
    try {
      const out = await fn();
      for (const d of Array.isArray(out) ? out : out ? [out] : []) {
        if (!d.candidate_id) d.candidate_id = id;
        if (d.candidate_id !== id) throw new Error("the translator returned a doc for another person");
        if (!d.source?.fetched_at || !d.source?.payload_hash || !d.mode) throw new Error("the doc has no source.fetched_at, source.payload_hash or mode");
        docs.push(d);
      }
    } catch (err) {
      errors.push({ where: label, error: why(err) });
    }
  };
  // The spec's arguments, plus the person's id last (the translators that cannot read it from their input take it there).
  await add("legacy_import", () => lib.fromLegacyImport(inp.row, inp.legacy, inp.v2));
  for (const l of inp.ledger) {
    const { raw_payload, ...ledgerRow } = l;
    // A few ledger rows are marked ok but hold no payload (9 on 2026-09-25): there is nothing to
    // translate, and an empty doc would be the newest list source and empty the lists.
    if (!raw_payload || typeof raw_payload !== "object" || Array.isArray(raw_payload)) continue;
    await add("harvest", () => lib.fromHarvest(raw_payload, ledgerRow, id));
  }
  if (inp.dir) await add("directory", () => lib.fromDirectory(inp.dir.board, inp.dir.harvest, inp.dir.exps, inp.dir.edus, inp.dir.emails, inp.dir.phones, id));
  for (const a of inp.apps) await add("application", () => lib.fromApplication(a, createdThePerson(a, inp.row), id));
  // Oldest -> newest, so the newest LinkedIn-grade source ends up owning the lists.
  docs.sort((x, y) => (Date.parse(x.source.fetched_at) || 0) - (Date.parse(y.source.fetched_at) || 0) || (SOURCE_ORDER[x.source.source] ?? 9) - (SOURCE_ORDER[y.source.source] ?? 9));
  return { docs, errors };
}

const docCounts = (d) => ({ jobs: arr(d.jobs).length, educations: arr(d.educations).length, skills: arr(d.skills).length, contacts: arr(d.contacts).length, identities: arr(d.identities).length });

// ---------------------------------------------------------------- reading the new tables back

async function readNew(site, ids) {
  const sources = await selectIn(site, "candidate_sources", "candidate_id", ids, { order: "candidate_id.asc,fetched_at.asc,id.asc" });
  const state = await selectIn(site, "candidate_profile_state", "candidate_id", ids, { order: "candidate_id.asc" });
  const identities = await selectIn(site, "candidate_identities", "candidate_id", ids, { order: "candidate_id.asc,kind.asc,value.asc" });
  const jobs = await selectIn(site, "candidate_experiences", "candidate_id", ids, { filters: [["source", "eq", "person"]], order: "candidate_id.asc,sort_order.asc,id.asc" });
  const educations = await selectIn(site, "candidate_educations", "candidate_id", ids, { order: "candidate_id.asc,sort_order.asc,id.asc" });
  const cskills = await selectIn(site, "candidate_skills", "candidate_id", ids, { order: "candidate_id.asc,skill_id.asc" });
  const contacts = await selectIn(site, "candidate_contacts", "candidate_id", ids, { order: "candidate_id.asc,kind.asc,value_normalized.asc" });
  const summary = await selectIn(site, "candidate_contact_summary", "candidate_id", ids, { order: "candidate_id.asc" });
  const conflictsById = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    for (const c of await site.select("identity_conflicts", { filters: [["candidate_ids", "ov", ids.slice(i, i + 40)]], order: "id.asc" })) conflictsById.set(c.id, c);
  }
  const companies = await selectIn(site, "companies", "id", jobs.map((j) => j.company_id), {
    columns: "id,name,linkedin_id,linkedin_username,linkedin_url,logo_url,normalized_name,linkedin_url_normalized,identity_basis,is_placeholder,tier,tier_list_version,merged_into,created_from",
    order: "id.asc",
  });
  const schools = await selectIn(site, "schools", "id", educations.map((e) => e.school_id), { order: "id.asc" });
  const skills = await selectIn(site, "skills", "id", cskills.map((s) => s.skill_id), { order: "id.asc" });
  const writerCompanies = await site.select("companies", { columns: "id", filters: [["created_from", "eq", "person_writer"]], order: "id.asc" });
  const writerSchools = await site.select("schools", { columns: "id", filters: [["created_from", "eq", "person_writer"]], order: "id.asc" });
  const conflicts = [...conflictsById.values()];
  return {
    sources: groupBy(sources, "candidate_id"),
    sourceById: new Map(sources.map((s) => [s.id, s])),
    state: new Map(state.map((s) => [s.candidate_id, s])),
    identities: groupBy(identities, "candidate_id"),
    jobs: groupBy(jobs, "candidate_id"),
    educations: groupBy(educations, "candidate_id"),
    cskills: groupBy(cskills, "candidate_id"),
    contacts: groupBy(contacts, "candidate_id"),
    summary: new Map(summary.map((s) => [s.candidate_id, s])),
    conflicts,
    companyById: new Map(companies.map((c) => [c.id, c])),
    schoolById: new Map(schools.map((s) => [s.id, s])),
    skillById: new Map(skills.map((s) => [String(s.id), s])),
    // Everything a second run must leave exactly as it was.
    fingerprint: {
      candidate_sources: hashOf(sources),
      candidate_profile_state: hashOf(state),
      candidate_identities: hashOf(identities),
      candidate_experiences: hashOf(jobs),
      candidate_educations: hashOf(educations),
      candidate_skills: hashOf(cskills),
      candidate_contacts: hashOf(contacts),
      identity_conflicts: hashOf(conflicts.sort((a, b) => String(a.id).localeCompare(String(b.id)))),
      writer_companies: hashOf(writerCompanies),
      writer_schools: hashOf(writerSchools),
    },
    writerCompanies: writerCompanies.length,
    writerSchools: writerSchools.length,
  };
}

/** What project() gets: the person's current rows, joined to their companies, schools and skills. */
function projectionInput(id, t) {
  const active = (rows) => (rows ?? []).filter((r) => !r.removed_at);
  const state = t.state.get(id) ?? null;
  // The state's header is {field: {value, source, at}}; project() reads plain values.
  const header = state?.header && typeof state.header === "object"
    ? Object.fromEntries(Object.entries(state.header).map(([k, v]) => [k, v && typeof v === "object" && "value" in v ? v.value : v]))
    : null;
  return {
    candidate_id: id,
    header,
    state,
    sources: t.sources.get(id) ?? [],
    identities: t.identities.get(id) ?? [],
    jobs: active(t.jobs.get(id)).map((j) => ({ ...j, company: t.companyById.get(j.company_id) ?? null })),
    educations: active(t.educations.get(id)).map((e) => ({ ...e, school: t.schoolById.get(e.school_id) ?? null })),
    skills: active(t.cskills.get(id)).map((s) => ({ ...s, name: t.skillById.get(String(s.skill_id))?.name ?? null, key: t.skillById.get(String(s.skill_id))?.key ?? null })),
    contacts: t.contacts.get(id) ?? [],
  };
}

// ---------------------------------------------------------------- the checks

export const CHECKS = {
  ids_found: ["spec", "every id is a pool person"],
  zero_errors: ["spec", "0 errors (translators and save_person)"],
  jobs_accounted: ["spec", "every job accounted for: the list owner's jobs are stored, nothing else"],
  jobs_linked: ["spec", "every stored job linked to a company"],
  emails_present: ["spec", "every known email present"],
  one_primary_email: ["spec", "exactly one primary email per person with a usable address"],
  repeat_unchanged: ["spec", "a second run changes nothing"],
  candidates_untouched: ["spec", "candidates rows identical before and after"],
  newest_source_owns_lists: ["extra", "the newest list source owns the lists"],
  educations_accounted: ["extra", "the list owner's schools are stored, nothing else"],
  skills_accounted: ["extra", "the list owner's skills are stored, nothing else"],
  phones_present: ["extra", "every known phone present"],
  one_primary_phone: ["extra", "exactly one primary phone per person with a usable phone"],
  dead_never_primary: ["extra", "invalid, bounced, claimed, removed or do-not-use contacts are never ranked"],
  summary_view_agrees: ["extra", "candidate_contact_summary names the rank-1 email"],
  other_experience_rows_untouched: ["extra", "candidate_experiences rows from other writers unchanged"],
  directory_read: ["extra", "every directory person's directory records were read"],
  docs_deterministic: ["extra", "the same sources give the same docs (payload hashes) on the second run"],
  projection_runs: ["extra", "project() runs on every person's stored rows"],
  docs_cover_known_emails: ["extra", "the docs carry every known email"],
  doc_jobs_named: ["extra", "every job in every doc names a company or a placeholder"],
};

class Tally {
  constructor() { this.fail = new Map(); this.ran = new Set(); this.notes = new Map(); }
  run(check) { this.ran.add(check); }
  bad(check, id, note) {
    this.ran.add(check);
    if (!this.fail.has(check)) this.fail.set(check, new Set());
    this.fail.get(check).add(id);
    if (note) this.notes.set(check, note);
  }
}

/** Doc-level checks: what the translators produced, before anything is saved. */
function checkDocs(tally, id, inp, docs) {
  tally.run("docs_cover_known_emails");
  tally.run("doc_jobs_named");
  const inDocs = new Set(docs.flatMap((d) => arr(d.contacts).filter((c) => c.kind === "email").map((c) => c.value_normalized)));
  const known = knownEmails(inp);
  const missing = [...known.keys()].filter((e) => !inDocs.has(e));
  if (missing.length) tally.bad("docs_cover_known_emails", id);
  const unnamed = docs.reduce((n, d) => n + arr(d.jobs).filter((j) => !j.company?.identity && !j.company?.is_placeholder).length, 0);
  if (unnamed) tally.bad("doc_jobs_named", id);
  return { knownEmails: known.size, emailsMissingFromDocs: missing.length, unnamedJobs: unnamed };
}

/** Checks over the stored rows of one person. Returns the counts printed for them. */
function checkStored(tally, id, inp, docs, t, lib) {
  const active = (rows) => (rows ?? []).filter((r) => !r.removed_at);
  const listDocs = docs.filter((d) => d.mode === "replace_lists");
  const newest = listDocs.reduce((best, d) => (!best || Date.parse(d.source.fetched_at) >= Date.parse(best.source.fetched_at) ? d : best), null);
  const state = t.state.get(id);
  const ownerSource = state?.lists_source_id ? t.sourceById.get(state.lists_source_id) : null;
  const owner = ownerSource ? docs.find((d) => d.source.payload_hash === ownerSource.payload_hash && d.source.source === ownerSource.source) : null;

  tally.run("newest_source_owns_lists");
  if (newest && (!owner || owner.source.payload_hash !== newest.source.payload_hash)) {
    // Another doc with the same fetched_at is as new; that is not a failure.
    if (!owner || Date.parse(owner.source.fetched_at) !== Date.parse(newest.source.fetched_at)) tally.bad("newest_source_owns_lists", id);
  }
  if (!newest && ownerSource) tally.bad("newest_source_owns_lists", id);

  const compare = (check, expected, stored) => {
    tally.run(check);
    const e = new Set(expected);
    const s = new Set(stored);
    const missing = [...e].filter((k) => !s.has(k)).length;
    const extra = [...s].filter((k) => !e.has(k)).length;
    const dupes = stored.length - s.size;
    if (missing || extra || dupes || (ownerSource && !owner)) tally.bad(check, id);
    return { expected: e.size, stored: stored.length, missing, extra };
  };
  // With no list owner (no replace_lists doc was ever applied), only gap-filling docs can have
  // added list rows (an applicant's resume jobs when there is no LinkedIn history).
  const listed = (field, key) => (owner ? arr(owner[field]) : docs.filter((d) => d.mode === "fill_gaps").flatMap((d) => arr(d[field]))).map(key);
  const jobs = active(t.jobs.get(id));
  const jobCounts = compare("jobs_accounted", listed("jobs", (j) => j.row_key), jobs.map((j) => j.row_key));
  const legacy = docs.find((d) => d.source.source === "legacy_import");
  const storedKeys = new Set(jobs.map((j) => j.row_key));
  // Jobs on today's record that the newer list owner no longer lists (shown on the page, not a failure).
  const superseded = owner && legacy && owner !== legacy ? arr(legacy.jobs).filter((j) => !storedKeys.has(j.row_key)).length : 0;
  const eduCounts = compare("educations_accounted", listed("educations", (e) => e.row_key), active(t.educations.get(id)).map((e) => e.row_key));
  const skillKeys = active(t.cskills.get(id)).map((s) => t.skillById.get(String(s.skill_id))?.key ?? `?${s.skill_id}`);
  const skillCounts = compare("skills_accounted", listed("skills", (s) => s.key), skillKeys);

  tally.run("jobs_linked");
  const linked = jobs.filter((j) => j.company_id && t.companyById.has(j.company_id)).length;
  if (linked !== jobs.length) tally.bad("jobs_linked", id);

  const contacts = t.contacts.get(id) ?? [];
  const emails = contacts.filter((c) => c.kind === "email");
  const phones = contacts.filter((c) => c.kind === "phone");
  tally.run("emails_present");
  const known = knownEmails(inp);
  const storedEmails = new Set(emails.map((c) => c.value_normalized));
  const emailsMissing = [...known.keys()].filter((e) => !storedEmails.has(e)).length;
  if (emailsMissing) tally.bad("emails_present", id);

  tally.run("phones_present");
  const storedPhones = new Set(phones.map((c) => phoneKey(c.value_normalized)).filter(Boolean));
  const phonesKnown = knownPhones(inp);
  const phonesMissing = [...phonesKnown].filter((p) => !storedPhones.has(p)).length;
  if (phonesMissing) tally.bad("phones_present", id);

  const eligible = (c) => c.status === "active" && !c.never_primary;
  const primaryOk = (rows, check) => {
    tally.run(check);
    const ranked1 = rows.filter((c) => Number(c.rank) === 1);
    const usable = rows.filter(eligible).length;
    const ok = usable ? ranked1.length === 1 && eligible(ranked1[0]) : ranked1.length === 0;
    if (!ok) tally.bad(check, id);
    return { usable, primary: ranked1.length };
  };
  const pe = primaryOk(emails, "one_primary_email");
  const pp = primaryOk(phones, "one_primary_phone");

  tally.run("dead_never_primary");
  if (contacts.some((c) => c.rank !== null && c.rank !== undefined && (c.status !== "active" || c.never_primary))) tally.bad("dead_never_primary", id);

  tally.run("summary_view_agrees");
  const top = emails.find((c) => Number(c.rank) === 1)?.value_normalized ?? null;
  const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  if (lower(t.summary.get(id)?.primary_email) !== lower(top)) tally.bad("summary_view_agrees", id);

  let projection = null;
  tally.run("projection_runs");
  try {
    projection = lib.project(projectionInput(id, t));
  } catch (err) {
    tally.bad("projection_runs", id, why(err));
  }
  const title = (v) => (typeof v === "string" ? v.trim().toLowerCase() : null);
  return {
    owner: owner ? docLabel(owner) : ownerSource ? `${ownerSource.source}@(not this run)` : null,
    record_jobs: arr(inp.row.work_experience).length,
    jobs: { ...jobCounts, linked, superseded },
    educations: eduCounts,
    skills: skillCounts,
    emails: { known: known.size, stored: emails.length, missing: emailsMissing, ranked: emails.filter((c) => c.rank !== null && c.rank !== undefined).length, ...pe },
    phones: { known: phonesKnown.size, stored: phones.length, missing: phonesMissing, ...pp },
    identities: (t.identities.get(id) ?? []).length,
    conflicts: t.conflicts.filter((c) => arr(c.candidate_ids).includes(id)).length,
    projection: projection
      ? { title_same: title(projection.current_title) === title(inp.row.current_title), company_same: title(projection.current_company) === title(inp.row.current_company) }
      : null,
    _projection: projection,
  };
}

// ---------------------------------------------------------------- the run

async function applyDocs(site, perPerson, concurrency = 4) {
  const results = new Map();
  const queue = [...perPerson.keys()];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const out = [];
      // One person's docs strictly in order: the order is the point.
      for (const doc of perPerson.get(id)) {
        try {
          const r = await site.rpc("save_person", { doc });
          const ok = r && ["created", "updated", "unchanged"].includes(r.status);
          out.push(ok ? { label: docLabel(doc), status: r.status, counts: r.counts ?? {} } : { label: docLabel(doc), status: "error", error: `unexpected result ${redact(stable(r)).slice(0, 120)}` });
        } catch (err) {
          out.push({ label: docLabel(doc), status: "error", error: why(err) });
        }
      }
      results.set(id, out);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function readAll(site, ids, commsDb, commsCols, skipDirectory = false) {
  const rows = await candidatesRows(site, ids);
  const inputs = await readSources(site, ids, rows);
  const dirIds = [...inputs.values()].map((i) => i.row.directory_contact_id).filter(Boolean);
  let dirMissing = 0;
  if (dirIds.length && skipDirectory) return { rows, inputs, dirIds: dirIds.length, dirMissing: 0, dirSkipped: true };
  if (dirIds.length) {
    if (!commsDb) throw new Error(`${dirIds.length} trial people are directory people: COMMS_DATABASE_URL is required`);
    const dir = await readDirectory(commsDb, dirIds, commsCols);
    for (const inp of inputs.values()) {
      const cid = inp.row.directory_contact_id;
      if (!cid) continue;
      inp.dir = dir.get(cid) ?? null;
      if (!inp.dir) dirMissing++;
    }
  }
  return { rows, inputs, dirIds: dirIds.length, dirMissing };
}

function counts(results) {
  const c = { docs: 0, created: 0, updated: 0, unchanged: 0, error: 0, companies_created: 0, schools_created: 0, conflicts: 0 };
  for (const rs of results.values()) {
    for (const r of rs) {
      c.docs++;
      c[r.status] = (c[r.status] ?? 0) + 1;
      c.companies_created += Number(r.counts?.companies_created ?? 0);
      c.schools_created += Number(r.counts?.schools_created ?? 0);
      c.conflicts += Number(r.counts?.conflicts ?? 0);
    }
  }
  return c;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes("--describe") || truthy(process.env.DESCRIBE)) return describe();

  const DRY_RUN = argv.includes("--dry-run") || truthy(process.env.DRY_RUN);
  const REPEAT = argv.includes("--repeat") || truthy(process.env.REPEAT);
  const SUMMARY_FILE = (process.env.SUMMARY_FILE || "").trim();
  const DETAIL_FILE = (process.env.DETAIL_FILE || "").trim();
  const SKIP_DIRECTORY = truthy(process.env.SKIP_DIRECTORY);
  if (SKIP_DIRECTORY && !DRY_RUN) throw new Error("SKIP_DIRECTORY is for dry runs only: a real run must read the directory");
  if (DETAIL_FILE && IN_CI) throw new Error("DETAIL_FILE holds personal data and is refused on GitHub Actions");
  const ids = parseIds({ list: opt("--ids") ?? process.env.TRIAL_IDS, file: opt("--file") ?? process.env.TRIAL_IDS_FILE });

  const lib = await import("./dist/worker-lib.mjs").catch((err) => { throw new Error(`scripts/dist/worker-lib.mjs: ${why(err)}; run node scripts/build-worker-lib.mjs`); });
  const absent = LIB_EXPORTS.filter((n) => typeof lib[n] !== "function");
  if (absent.length) throw new Error(`the worker bundle has no ${absent.join(", ")}; rebuild it from a branch with lib/server/person`);

  const site = await openSite();
  let commsDb = null;
  let commsCols = new Map();
  if (process.env.COMMS_DATABASE_URL) {
    commsDb = await openComms(process.env.COMMS_DATABASE_URL);
    commsCols = await commsColumns(commsDb);
  }
  const tally = new Tally();
  const t0 = Date.now();
  try {
    console.log(`person trial: ${ids.length} ids, website ${site.kind}, directory ${commsDb ? "connected" : "not configured"}${DRY_RUN ? ", dry run (nothing saved)" : ""}${REPEAT ? ", repeat" : ""}`);

    // 1. Before: the candidates rows and other writers' experience rows, hashed.
    const before = await readAll(site, ids, commsDb, commsCols, SKIP_DIRECTORY);
    const beforeHash = hashRows(before.rows);
    const beforeOther = await otherExperienceHashes(site, ids);
    tally.run("ids_found");
    for (const id of ids) if (!before.rows.has(id)) tally.bad("ids_found", id);
    tally.run("directory_read");
    for (const [id, inp] of before.inputs) if (inp.row.directory_contact_id && !inp.dir) tally.bad("directory_read", id);
    if (SKIP_DIRECTORY) tally.notes.set("directory_read", "SKIP_DIRECTORY: the directory was not read");
    console.log(`read: ${before.rows.size} candidates, ${before.dirIds} linked to the directory${before.dirSkipped ? " (not read: SKIP_DIRECTORY)" : before.dirMissing ? ` (${before.dirMissing} not found there)` : ""}`);

    // 2. The docs.
    const docsBy = new Map();
    const perPerson = new Map();
    tally.run("zero_errors");
    for (const [id, inp] of before.inputs) {
      const { docs, errors } = await buildDocs(lib, id, inp);
      docsBy.set(id, docs);
      const docCheck = checkDocs(tally, id, inp, docs);
      if (errors.length) tally.bad("zero_errors", id);
      const emptyLedger = inp.ledger.filter((l) => !l.raw_payload || typeof l.raw_payload !== "object" || Array.isArray(l.raw_payload)).length;
      perPerson.set(id, { docs, buildErrors: errors, docCheck, inputs: { legacy: inp.legacy.length, v2: inp.v2.length, ledger: inp.ledger.length, ledger_without_payload: emptyLedger, apps: inp.apps.length, directory: !!inp.dir } });
    }

    let results = new Map();
    let second = null;
    let stored = null;
    if (!DRY_RUN) {
      // 3. Save, oldest -> newest per person.
      results = await applyDocs(site, docsBy);
      for (const [id, rs] of results) if (rs.some((r) => r.status === "error")) tally.bad("zero_errors", id);
      stored = await readNew(site, ids);

      // 4. The second run: the sources read again, the docs built again, everything saved again.
      if (REPEAT) {
        const again = await readAll(site, ids, commsDb, commsCols);
        const docs2 = new Map();
        tally.run("docs_deterministic");
        for (const [id, inp] of again.inputs) {
          const { docs, errors } = await buildDocs(lib, id, inp);
          docs2.set(id, docs);
          if (errors.length) tally.bad("zero_errors", id);
          const h1 = (docsBy.get(id) ?? []).map((d) => d.source.payload_hash).join(",");
          if (docs.map((d) => d.source.payload_hash).join(",") !== h1) tally.bad("docs_deterministic", id);
        }
        const results2 = await applyDocs(site, docs2);
        const stored2 = await readNew(site, ids);
        tally.run("repeat_unchanged");
        for (const [id, rs] of results2) {
          if (rs.some((r) => r.status === "error")) tally.bad("zero_errors", id);
          if (rs.some((r) => r.status !== "unchanged")) tally.bad("repeat_unchanged", id);
        }
        const moved = Object.keys(stored.fingerprint).filter((k) => stored.fingerprint[k] !== stored2.fingerprint[k]);
        if (moved.length) tally.bad("repeat_unchanged", "*", `tables changed by the second run: ${moved.join(", ")}`);
        second = { counts: counts(results2), tables_changed: moved };
        stored = stored2;
      }
    }

    // 5. After: the candidates rows must be exactly as before.
    const afterRows = await candidatesRows(site, ids);
    const afterHash = hashRows(afterRows);
    const afterOther = await otherExperienceHashes(site, ids);
    tally.run("candidates_untouched");
    tally.run("other_experience_rows_untouched");
    let movedByOthers = 0;
    for (const id of ids) {
      if (beforeHash.get(id) !== afterHash.get(id)) {
        tally.bad("candidates_untouched", id);
        if (before.rows.get(id)?.updated_at !== afterRows.get(id)?.updated_at) movedByOthers++;
      }
      if (beforeOther.get(id) !== afterOther.get(id)) tally.bad("other_experience_rows_untouched", id);
    }
    if (movedByOthers) tally.notes.set("candidates_untouched", `${movedByOthers} changed row(s) have a new updated_at: another writer (refresh, directory sync, a recruiter) ran during the trial; the writer never writes candidates`);

    // 6. Per person, the stored rows against the docs.
    const people = [];
    const detail = [];
    for (const id of ids) {
      const p = perPerson.get(id);
      if (!p) { people.push({ id, found: false }); continue; }
      const inp = before.inputs.get(id);
      const saved = results.get(id) ?? [];
      const check = stored ? checkStored(tally, id, inp, p.docs, stored, lib) : null;
      const docsOut = p.docs.map((d, i) => ({ source: d.source.source, fetched_at: String(d.source.fetched_at).slice(0, 10), mode: d.mode, ...docCounts(d), status: saved[i]?.status ?? (DRY_RUN ? "dry_run" : null) }));
      const errors = [...p.buildErrors, ...saved.filter((r) => r.status === "error").map((r) => ({ where: r.label, error: r.error }))];
      const person = { id, inputs: p.inputs, docs: docsOut, doc_check: p.docCheck, errors };
      if (check) {
        const { _projection, ...rest } = check;
        Object.assign(person, rest);
        if (DETAIL_FILE) detail.push({ id, projection: _projection });
      }
      people.push(person);
      const docText = docsOut.map((d) => `${d.source}@${d.fetched_at}:${d.mode}${d.status && d.status !== "dry_run" ? `=${d.status}` : ""}(${d.jobs}j/${d.educations}e/${d.skills}s/${d.contacts}c)`).join(" ");
      const storedText = check
        ? ` | owner ${check.owner ?? "none"}; jobs ${check.jobs.stored}/${check.jobs.expected} linked ${check.jobs.linked}${check.jobs.superseded ? ` superseded ${check.jobs.superseded}` : ""}; schools ${check.educations.stored}/${check.educations.expected}; skills ${check.skills.stored}/${check.skills.expected}; emails ${check.emails.stored} (known ${check.emails.known}, missing ${check.emails.missing}, primary ${check.emails.primary}); phones ${check.phones.stored} (known ${check.phones.known}); conflicts ${check.conflicts}`
        : ` | known emails ${p.docCheck.knownEmails}${p.docCheck.emailsMissingFromDocs ? `, ${p.docCheck.emailsMissingFromDocs} not in any doc` : ""}${p.docCheck.unnamedJobs ? `, ${p.docCheck.unnamedJobs} jobs without a company` : ""}`;
      console.log(`${id} ${docText}${storedText}${errors.length ? ` | ERRORS ${errors.map((e) => `${e.where}: ${e.error}`).join("; ")}` : ""}`);
    }

    // 7. The verdict.
    const checks = Object.entries(CHECKS)
      .filter(([k]) => tally.ran.has(k))
      .map(([k, [kind, what]]) => {
        const failed = [...(tally.fail.get(k) ?? [])];
        return { name: k, kind, what, pass: failed.length === 0, failed_ids: failed, note: tally.notes.get(k) ?? null };
      });
    console.log("");
    for (const c of checks) {
      const n = c.failed_ids.filter((x) => x !== "*").length;
      console.log(`CHECK ${c.pass ? "PASS" : "FAIL"} ${c.kind.padEnd(5)} ${c.name.padEnd(32)} ${c.what}${c.pass ? "" : ` | failed: ${n} ${c.failed_ids.join(", ")}`}${c.note ? ` | ${c.note}` : ""}`);
    }
    const allDocs = [...docsBy.values()].flat();
    const totals = DRY_RUN ? {
      people: ids.length,
      docs: allDocs.length,
      doc_jobs: allDocs.reduce((n, d) => n + arr(d.jobs).length, 0),
      doc_contacts: allDocs.reduce((n, d) => n + arr(d.contacts).length, 0),
      known_emails: people.reduce((n, p) => n + (p.doc_check?.knownEmails ?? 0), 0),
      ledger_rows_without_payload: people.reduce((n, p) => n + (p.inputs?.ledger_without_payload ?? 0), 0),
    } : {
      people: ids.length,
      ...counts(results),
      ledger_rows_without_payload: people.reduce((n, p) => n + (p.inputs?.ledger_without_payload ?? 0), 0),
      jobs_stored: people.reduce((n, p) => n + (p.jobs?.stored ?? 0), 0),
      jobs_superseded: people.reduce((n, p) => n + (p.jobs?.superseded ?? 0), 0),
      emails_stored: people.reduce((n, p) => n + (p.emails?.stored ?? 0), 0),
      people_with_primary_email: people.filter((p) => p.emails?.primary === 1).length,
      people_without_usable_email: people.filter((p) => p.emails && !p.emails.usable).length,
      phones_stored: people.reduce((n, p) => n + (p.phones?.stored ?? 0), 0),
      projection_title_same: people.filter((p) => p.projection?.title_same).length,
      projection_title_different: people.filter((p) => p.projection && !p.projection.title_same).length,
      writer_companies: stored?.writerCompanies ?? null,
      writer_schools: stored?.writerSchools ?? null,
      conflict_rows: stored?.conflicts.length ?? null,
    };
    console.log(`totals: ${Object.entries(totals).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (second) console.log(`second run: ${Object.entries(second.counts).map(([k, v]) => `${k} ${v}`).join(", ")}${second.tables_changed.length ? `; tables changed: ${second.tables_changed.join(", ")}` : "; no table changed"}`);
    const pass = checks.every((c) => c.pass);
    console.log(`${pass ? "PASS" : "FAIL"} in ${Math.round((Date.now() - t0) / 1000)}s`);

    if (SUMMARY_FILE) {
      fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ run_at: new Date().toISOString(), dry_run: DRY_RUN, repeat: REPEAT, website: site.kind, pass, checks, totals, second, people }, null, 1));
      console.log(`summary written to ${SUMMARY_FILE}`);
    }
    if (DETAIL_FILE) {
      await writeDetail(site, DETAIL_FILE, ids, before, docsBy, results, stored, detail);
      console.log(`detail (personal data, keep local) written to ${DETAIL_FILE}`);
    }
    return pass ? 0 : 1;
  } finally {
    await site.end();
    if (commsDb) await commsDb.end();
  }
}

/** Local only: everything the before/after page needs, per person. Holds personal data. */
async function writeDetail(site, file, ids, before, docsBy, results, stored, projections) {
  const RECORD = ["full_name", "headline", "location", "profile_picture_url", "current_title", "current_company", "work_experience", "education", "education_schools", "education_degrees", "education_fields", "top_skills", "all_skills_text", "previous_companies", "calculated_experience_years", "total_experience_years", "email", "phone", "contact", "source", "linkedin_username", "linkedin_enrichment_date", "directory_contact_id", "airtable_id", "created_at", "updated_at"];
  const network = await selectIn(site, "network_matches", "candidate_id", ids, { columns: "candidate_id,org_role_id,label,strength,full_name,current_title,current_company,refreshed_at", filters: [["organization_id", "eq", TT_ORG]], order: "candidate_id.asc,org_role_id.asc" });
  const signals = await selectIn(site, "person_signals", "candidate_id", ids, { order: "candidate_id.asc" });
  const net = groupBy(network, "candidate_id");
  const sig = new Map(signals.map((s) => [s.candidate_id, s]));
  const proj = new Map(projections.map((p) => [p.id, p.projection]));
  const out = ids.map((id) => {
    const inp = before.inputs.get(id);
    if (!inp) return { id, found: false };
    const t = stored ? projectionInput(id, stored) : null;
    return {
      id,
      record: Object.fromEntries(RECORD.map((k) => [k, inp.row[k] ?? null])),
      network: net.get(id) ?? [],
      signals: sig.get(id) ?? null,
      inputs: { candidate_emails: inp.legacy, candidate_emails_v2: inp.v2, ledger: inp.ledger.map(({ raw_payload, ...l }) => l), applications: inp.apps.map((a) => ({ id: a.id, created_at: a.created_at, source: a.source, email: a.email, contact: a.contact })), directory: inp.dir ? { board: inp.dir.board, emails: inp.dir.emails, phones: inp.dir.phones, harvest_fetched_at: inp.dir.harvest?.fetched_at ?? null } : null },
      docs: docsBy.get(id) ?? [],
      results: results.get(id) ?? [],
      tables: t ? { ...t, summary: stored.summary.get(id) ?? null, conflicts: stored.conflicts.filter((c) => arr(c.candidate_ids).includes(id)) } : null,
      projection: proj.get(id) ?? null,
    };
  });
  fs.writeFileSync(file, JSON.stringify({ written_at: new Date().toISOString(), people: out }, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code ?? 0)).catch((err) => { console.error(why(err)); process.exit(1); });
}

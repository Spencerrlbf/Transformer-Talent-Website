#!/usr/bin/env node
// Turns Paraform project exports into the graded employer list the signals
// read: lib/server/signals/paraform-employers.json. Each person in an export
// carries a "Talent Density" grade (S, A, B, C); a company's grade is the
// grade most of its people carry, ties going to the better grade. S and A
// become tier 1, B and C tier 2. Only company names and counts are written;
// nothing about the people leaves the export.
//
//   node scripts/import-paraform-grades.mjs "~/Downloads/Paraform Projects - A-D Series - Latest.csv" "~/Downloads/Paraform Projects - Big Companies - Latest.csv"
import fs from "node:fs";
import path from "node:path";

const files = process.argv.slice(2).map((f) => f.replace(/^~/, process.env.HOME || ""));
if (!files.length) throw new Error("pass one or more Paraform CSV exports");
const OUT = new URL("../lib/server/signals/paraform-employers.json", import.meta.url);
const GRADE_TIER = { S: 1, A: 1, B: 2, C: 2 };
const ORDER = ["S", "A", "B", "C"];
// Not companies: placeholders, self-employment, schools, clubs, funds.
const NOT_A_COMPANY = /\b(stealth|self[- ]?employed|freelanc\w*|independent|consultant|contractor|university|college|school|institute of technology|academy|laboratory|club|careers|hiring|untitled|coming soon|\.edu)\b|^(none|n\/a|unemployed|retired|student|various|ucla|ucsd|ucsf|mit|caltech|ieee|nyu)$/i;
// A cell that names more than one thing, or is not a name at all.
const NOT_A_NAME = /[\/|@]|www\.|https?:|[^\x20-\x7E\u00C0-\u024F]/;

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

/** The display name: the part before a " - " or " · " tag, no bracketed
 *  tag, no trademark sign, no legal suffix, no trailing dot. */
const cleanName = (s) =>
  s.split(/\s+[-\u00B7\u2013\u2014]\s+/)[0]
    .replace(/\s*\([^)]*\)?\s*$/, "")
    .replace(/[\u2122\u00AE*]/g, "")
    .replace(/[,\s]+(inc|llc|ltd|limited|corp|corporation|plc|gmbh|co)\.?$/i, "")
    .replace(/\s+/g, " ").replace(/\.$/, "").trim();
const keyOf = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

const companies = new Map(); // key -> { name, grades: {S,A,B,C}, people }
let people = 0, ungraded = 0, skipped = 0;
for (const f of files) {
  for (const r of parseCsv(fs.readFileSync(f, "utf8").replace(/^﻿/, ""))) {
    const grade = (r["Talent Density"] || "").toUpperCase();
    const company = cleanName((r["Current Role"] || "").split(",")[0]);
    if (!(grade in GRADE_TIER) || !company) { ungraded++; continue; }
    if (NOT_A_COMPANY.test(company) || NOT_A_NAME.test(company) || !/[a-z]/i.test(company)) { skipped++; continue; }
    const key = keyOf(company);
    if (!key) { skipped++; continue; }
    const entry = companies.get(key) || { name: company, grades: { S: 0, A: 0, B: 0, C: 0 }, people: 0 };
    entry.grades[grade]++; entry.people++;
    companies.set(key, entry); people++;
  }
}
const out = [...companies.values()].map((e) => {
  const grade = ORDER.slice().sort((a, b) => e.grades[b] - e.grades[a] || ORDER.indexOf(a) - ORDER.indexOf(b))[0];
  return { name: e.name, grade, tier: GRADE_TIER[grade], people: e.people, grades: e.grades };
}).sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));
fs.writeFileSync(OUT, JSON.stringify({ source: "Paraform project exports", imported: new Date().toISOString().slice(0, 10), rule: "company grade = majority grade of its people, ties to the better grade; S and A are tier 1, B and C tier 2", companies: out }, null, 1) + "\n");
const t1 = out.filter((e) => e.tier === 1).length;
console.log(`${files.length} file(s): ${people} graded people at ${out.length} companies (${t1} tier 1, ${out.length - t1} tier 2); ${ungraded} rows without a grade or company, ${skipped} non-company rows skipped`);
console.log(`wrote ${path.relative(process.cwd(), OUT.pathname)}`);

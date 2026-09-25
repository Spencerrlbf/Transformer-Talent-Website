// Normalisation shared by every translator. The SQL (save_person) trusts
// these values: row keys, skill keys, e-mail and phone forms, company and
// school names and identities. Everything here is pure: no database, no
// network, and the same input always gives the same output.
import crypto from "node:crypto";
import { cleanText, SIDE_ROLE } from "../spine";
import { skillKey } from "../facts";
import { normalise, topEmployerOf, topUniversityOf } from "../signals/match";
import type {
  ContactLabel,
  ContactStatus,
  DegreeLevel,
  PersonCompany,
  PersonContact,
  PersonDoc,
  PersonEducation,
  PersonHeader,
  PersonIdentity,
  PersonJob,
  PersonSchool,
  PersonSkill,
  PersonSource,
} from "./types";

/** Bumped whenever a translator's output changes for the same input. */
export const PARSER_VERSION = "person-v1";

/** Transformer Talent's organization: the only one whose people enter the pool. */
export const TT_ORG_ID = "801865a7-6533-41d2-9c45-e4a90e6ad51a";

// ---------- small value helpers ----------

export const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/** JSON with object keys sorted at every level, so equal values hash equally. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** One line of text: control characters and runs of whitespace become one space (spine.ts cleanText). */
export const clean = (s: unknown): string | null => cleanText(typeof s === "number" ? String(s) : s);

/** Long text (descriptions, summaries): control characters removed, line breaks kept. */
export const cleanLong = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const t = s.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ").replace(/[ \t]+\n/g, "\n").trim();
  return t || null;
};

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
/** 1-12 from a number or a month name; 0 and anything else is null. */
export function monthOf(m: unknown): number | null {
  if (typeof m === "number") return Number.isInteger(m) && m >= 1 && m <= 12 ? m : null;
  if (typeof m !== "string" || !m.trim()) return null;
  const t = m.trim().toLowerCase();
  if (/^\d{1,2}$/.test(t)) return monthOf(Number(t));
  return MONTHS[t.slice(0, 4)] ?? MONTHS[t.slice(0, 3)] ?? null;
}
/** A plausible year (1900-2100) or null; 0 (LinkedIn's "no end") is null. */
export function yearOf(y: unknown): number | null {
  const n = typeof y === "string" && /^\d{4}$/.test(y.trim()) ? Number(y) : y;
  return typeof n === "number" && Number.isInteger(n) && n > 1900 && n < 2100 ? n : null;
}

// ---------- row keys ----------

/** Lower case, punctuation to spaces, one space between words. */
export const normalizeTitle = (t: string | null | undefined): string =>
  String(t || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim();

/** sha256(company identity | normalized title | start_year-start_month), first 32 hex. */
export function jobRowKey(companyIdentity: string | null, title: string | null, startYear: number | null, startMonth: number | null): string {
  return sha256(`${companyIdentity ?? ""}|${normalizeTitle(title)}|${startYear ?? ""}-${startMonth ?? ""}`).slice(0, 32);
}

/** sha256(school identity | normalized degree | start_year), first 32 hex. */
export function eduRowKey(schoolIdentity: string, degree: string | null, startYear: number | null): string {
  return sha256(`${schoolIdentity}|${normalizeTitle(degree)}|${startYear ?? ""}`).slice(0, 32);
}

/** Two list rows with one key: an exact duplicate (same content) is dropped;
 *  a different row that happens to share the key (the same title at the same
 *  company with the same start, say two undated stints) gets a numbered key
 *  (`<key>` then sha(`<key>#2`)), so the unique (candidate_id, row_key) holds
 *  and nothing is lost. `content` says what "the same" means. Returns the
 *  kept rows and how many exact duplicates were dropped. */
export function dedupeRowKeys<T extends { row_key: string }>(rows: T[], content: (r: T) => string): { rows: T[]; duplicates: number } {
  const seen = new Map<string, Set<string>>();
  const out: T[] = [];
  let duplicates = 0;
  for (const r of rows) {
    const base = r.row_key;
    const contents = seen.get(base) ?? new Set<string>();
    const c = content(r);
    if (contents.has(c)) {
      duplicates++;
      continue;
    }
    const n = contents.size;
    contents.add(c);
    seen.set(base, contents);
    out.push(n === 0 ? r : { ...r, row_key: sha256(`${base}#${n + 1}`).slice(0, 32) });
  }
  return { rows: out, duplicates };
}

// ---------- side roles and the order of jobs ----------

/** A membership, board seat, advisory or volunteer role, not the job (spine.ts SIDE_ROLE). */
export const isSideRole = (title: string | null | undefined, company: string | null | undefined): boolean =>
  SIDE_ROLE.test(`${title ?? ""} ${company ?? ""}`);

/** The person's real job goes first: the current one that is not a side
 *  role, else the latest that is not; the rest keep their order. The same
 *  rule as harvestToPoolRecord (spine.ts), which the judge, the signals and
 *  the Profile tab already read. */
export function realJobFirst<T extends { is_current: boolean; is_side_role: boolean }>(jobs: T[]): T[] {
  const out = [...jobs];
  let job = out.findIndex((j) => j.is_current && !j.is_side_role);
  if (job < 0) job = out.findIndex((j) => !j.is_side_role);
  if (job > 0) out.unshift(...out.splice(job, 1));
  return out;
}

// ---------- companies and schools ----------

/** Company or school name as a lookup key: lower case, no accents, no
 *  punctuation, no legal suffix (Inc, LLC, Ltd, GmbH, Corp ...), no leading
 *  "the" (signals/match.ts normalise). A name in a script that has no Latin
 *  letters keeps its own letters rather than becoming empty. */
export function normalizedName(name: string | null | undefined): string | null {
  const s = clean(name);
  if (!s) return null;
  const n = normalise(s);
  if (n) return n;
  const own = s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return own || null;
}

/** The shared placeholder employers: a name that says no company. */
const PLACEHOLDERS: [RegExp, string][] = [
  [/^self[\s-]*employed\b/, "self employed"],
  [/^(freelance|freelancer|freelancing)$/, "freelance"],
  [/^stealth\b/, "stealth"],
  [/^career break$/, "career break"],
  [/^confidential\b/, "confidential"],
];
export function placeholderKey(name: string | null | undefined): string | null {
  const n = normalizedName(name);
  if (!n) return null;
  for (const [re, key] of PLACEHOLDERS) if (re.test(n)) return key;
  return null;
}

export interface LinkedinOrgUrl {
  kind: "company" | "school" | "showcase";
  slug: string;
  /** The slug when it is a number: LinkedIn's organization id. */
  id: string | null;
  /** The slug when it is a name. */
  username: string | null;
  normalized: string;
}
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
/** A LinkedIn company, school or showcase page URL, or null (a search URL is not a page). */
export function parseLinkedinOrgUrl(url: string | null | undefined): LinkedinOrgUrl | null {
  if (!url || typeof url !== "string") return null;
  const m = url.trim().match(/linkedin\.com\/(company|school|showcase)\/([^/?#\s]+)/i);
  if (!m) return null;
  const kind = m[1].toLowerCase() as LinkedinOrgUrl["kind"];
  const slug = safeDecode(m[2]).trim().toLowerCase();
  if (!slug) return null;
  const numeric = /^\d+$/.test(slug);
  return {
    kind,
    slug,
    id: numeric ? String(Number(slug)) : null,
    username: numeric ? null : slug,
    normalized: `https://www.linkedin.com/${kind}/${slug}`,
  };
}

const idString = (v: unknown): string | null => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^\d+$/.test(s) && Number(s) > 0 ? String(Number(s)) : null;
};
const usernameString = (v: unknown): string | null => {
  const s = typeof v === "string" ? safeDecode(v.trim()).toLowerCase() : "";
  return s || null;
};

/** The company identity string: li:<LinkedIn id> | u:<username> | url:<normalized URL> | n:<normalized name>. */
export function companyIdentity(c: Pick<PersonCompany, "linkedin_id" | "linkedin_username" | "linkedin_url_normalized" | "normalized_name">): string | null {
  if (c.linkedin_id) return `li:${c.linkedin_id}`;
  if (c.linkedin_username) return `u:${c.linkedin_username}`;
  if (c.linkedin_url_normalized) return `url:${c.linkedin_url_normalized}`;
  if (c.normalized_name) return `n:${c.normalized_name}`;
  return null;
}

/** A job's company from whatever the source holds. A numeric username counts as an id. */
export function companyOf(input: { name?: unknown; linkedin_id?: unknown; linkedin_username?: unknown; linkedin_url?: unknown; logo_url?: unknown }): PersonCompany {
  // "." or "-" names no company.
  const given = clean(input.name);
  const name = given && /[\p{L}\p{N}]/u.test(given) ? given : null;
  const rawUrl = clean(input.linkedin_url);
  const parsed = parseLinkedinOrgUrl(rawUrl);
  let id = idString(input.linkedin_id) ?? parsed?.id ?? null;
  let username = usernameString(input.linkedin_username) ?? parsed?.username ?? null;
  if (username && /^\d+$/.test(username)) {
    id = id ?? idString(username);
    username = null;
  }
  const urlNorm = parsed?.normalized ?? null;
  const ph = !id && !username && !urlNorm ? placeholderKey(name) : null;
  const normalized_name = ph ?? normalizedName(name);
  const company: PersonCompany = {
    name,
    linkedin_id: id,
    linkedin_username: username,
    linkedin_url: rawUrl && /linkedin\.com\//i.test(rawUrl) ? rawUrl : null,
    logo_url: clean(input.logo_url),
    tier: name && !ph ? topEmployerOf([name])?.tier ?? null : null,
    normalized_name,
    linkedin_url_normalized: urlNorm,
    identity: null,
    is_placeholder: !!ph,
  };
  company.identity = companyIdentity(company);
  return company;
}

/** A school from whatever the source holds; null when it has no name. */
export function schoolOf(input: { name?: unknown; linkedin_org_id?: unknown; linkedin_url?: unknown; logo_url?: unknown }): PersonSchool | null {
  const name = clean(input.name);
  const normalized_name = normalizedName(name);
  if (!name || !normalized_name) return null;
  const rawUrl = clean(input.linkedin_url);
  const parsed = parseLinkedinOrgUrl(rawUrl);
  const id = idString(input.linkedin_org_id) ?? parsed?.id ?? null;
  const urlNorm = parsed?.normalized ?? null;
  return {
    name,
    linkedin_org_id: id,
    linkedin_url: rawUrl && /linkedin\.com\//i.test(rawUrl) ? rawUrl : null,
    logo_url: clean(input.logo_url),
    tier: topUniversityOf([name])?.tier ?? null,
    normalized_name,
    linkedin_url_normalized: urlNorm,
    identity: id ? `li:${id}` : urlNorm ? `url:${urlNorm}` : `n:${normalized_name}`,
  };
}

// ---------- degrees ----------

const LEVELS: [DegreeLevel, RegExp][] = [
  ["high_school", /international baccalaureate|\bib diploma\b|high school|secondary school|higher secondary|senior secondary|\ba[- ]?levels?\b|\bgcse\b|\bhsc\b|\bssc\b|\b(10|12)th\b|matriculation|abitur|gymnasium|middle school/],
  ["professional", /\bj\.?\s?d\.?\b|juris doctor|\bm\.?\s?d\.?\b|doctor of medicine|\bd\.?\s?d\.?\s?s\b|\bd\.?\s?m\.?\s?d\b|pharm\.?\s?d|doctor of pharmacy|\bd\.?\s?v\.?\s?m\b|\bll\.?\s?[bm]\b|\bm\.?\s?b\.?\s?b\.?\s?s\b/],
  ["doctorate", /\bph\.?\s?d|\bd\.?\s?phil|doctor|doctoral|\bed\.?\s?d\b|\bd\.?\s?sc\b|\bd\.?\s?eng\b|\bdba\b|докт|кандидат наук/],
  ["mba", /\bm\.?\s?b\.?\s?a\b|master of business administration|\bemba\b/],
  ["master", /master|\bm\.?\s?s\.?\s?c?\b|\bm\.?\s?eng\b|\bmeng\b|\bm\.?\s?tech\b|\bm\.?\s?phil\b|\bm\.?\s?a\.?\b|\bm\.?\s?f\.?\s?a\b|\bmres\b|\bmpa\b|\bmpp\b|\bmcs\b|\bm\.?\s?cs\b|\bmca\b|\bm\.?\s?com\b|магистр|maestr[ií]a|mestrado|diplom[- ]?ingenieur|laurea magistrale/],
  ["bachelor", /bachelor|\bb\.?\s?s\.?\s?c?\b|\bb\.?\s?a\.?\b|\bb\.?\s?eng\b|\bbeng\b|\bb\.?\s?tech\b|\bb\.?\s?e\.?\b|\bba\.?sc\b|\ba\.?\s?b\.?\b|\bbcs\b|\bbba\b|\bb\.?\s?com\b|\bbca\b|undergrad|baccalaureate|бакалавр|licenciatur|\blicence\b|\blaurea\b|\bgrado\b/],
  ["associate", /associate|\ba\.a\.s?\b|\ba\.s\.|\baas\b/],
  ["certificate", /certificat|certification|bootcamp|nanodegree|diploma|course|program|training|specialization|exchange|visiting/],
];
/** The level a degree text states, or null when there is no degree text. */
export function degreeLevel(degree: string | null | undefined): DegreeLevel | null {
  const t = clean(degree)?.toLowerCase();
  if (!t) return null;
  for (const [level, re] of LEVELS) if (re.test(t)) return level;
  return "other";
}

// ---------- skills ----------

/** "Name : 12" is the name and an endorsement count; anything else is a name. */
export function splitSkill(raw: unknown): { name: string; endorsements: number | null } | null {
  const s = clean(typeof raw === "string" ? raw : raw && typeof raw === "object" ? (raw as { name?: unknown }).name : null);
  if (!s) return null;
  const m = s.match(/^(.*\S)\s+:\s+(\d+)$/);
  return m ? { name: m[1].trim(), endorsements: Number(m[2]) } : { name: s, endorsements: null };
}

/** The facts.ts skill key; a name in a script with no Latin letters keeps its own letters. */
export function skillKeyOf(name: string): string {
  return skillKey(name) || name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Values that are not skills: placeholders from forms and imports. */
const FILLER = /^(none|n\/?a|na|nil|null|not specified|unspecified|flexible|other|others|various|misc|-+|\.+|\?+|tbd|no skills?)$/i;
/** A skill name worth keeping: not a filler word, not a sentence (the poolSkills 60-character rule). */
export const isRealSkill = (name: string): boolean => !!name && name.length <= 60 && !FILLER.test(name.trim()) && /[\p{L}\p{N}]/u.test(name);

/** "12 endorsements" / "1 endorsement" / 12 -> 12. */
export function endorsementCount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v === "string") {
    const m = v.match(/(\d[\d,]*)/);
    if (m) return Number(m[1].replace(/,/g, ""));
  }
  return null;
}

/** Collects skills in first-seen order, one per key, keeping the best facts about each. */
export class SkillBag {
  private byKey = new Map<string, PersonSkill>();
  add(raw: unknown, opts: { is_top?: boolean; endorsements?: number | null } = {}): string | null {
    const split = splitSkill(raw);
    if (!split || !isRealSkill(split.name)) return null;
    const key = skillKeyOf(split.name);
    if (!key) return null;
    const endorsements = opts.endorsements ?? split.endorsements;
    const had = this.byKey.get(key);
    if (had) {
      had.is_top = had.is_top || !!opts.is_top;
      if (endorsements != null && (had.endorsements == null || endorsements > had.endorsements)) had.endorsements = endorsements;
      return key;
    }
    this.byKey.set(key, { name: split.name, key, is_top: !!opts.is_top, endorsements: endorsements ?? null, job_count: null, sort_order: this.byKey.size });
    return key;
  }
  has(name: string): boolean {
    const split = splitSkill(name);
    return !!split && this.byKey.has(skillKeyOf(split.name));
  }
  /** The skills, with job_count from the jobs' skill tags. */
  list(jobs: Pick<PersonJob, "skills">[] = []): PersonSkill[] {
    const counts = new Map<string, number>();
    for (const j of jobs) for (const k of new Set(j.skills.map((s) => skillKeyOf(splitSkill(s)?.name ?? s)))) counts.set(k, (counts.get(k) ?? 0) + 1);
    return [...this.byKey.values()].map((s) => ({ ...s, job_count: counts.get(s.key) ?? null }));
  }
}

/** A per-position skills cell: an array of names, or LinkedIn's rendered
 *  text ("Go (Programming Language), Algorithms and +12 skills", "A and B").
 *  " and " splits a name only when the whole is not already a known skill. */
export function jobSkillNames(v: unknown, known?: SkillBag): string[] {
  const parts: string[] = [];
  const pieces = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  for (const p of pieces) {
    const s = clean(typeof p === "string" ? p : p && typeof p === "object" ? (p as { name?: unknown }).name : null);
    if (!s) continue;
    const trimmed = s.replace(/\s*(,|\band\b)?\s*\+\s*\d+\s+skills?\s*$/i, "").trim();
    for (const piece of trimmed.split(/\s*,\s*/)) {
      if (!piece) continue;
      if (/\s+and\s+/i.test(piece) && !(known && known.has(piece))) parts.push(...piece.split(/\s+and\s+/i));
      else parts.push(piece);
    }
  }
  const seen = new Set<string>();
  return parts
    .map((p) => p.trim())
    .filter((p) => isRealSkill(p))
    .filter((p) => {
      const k = skillKeyOf(p);
      return !seen.has(k) && !!seen.add(k);
    });
}

// ---------- contacts ----------

/** lower case, trimmed, mailto: and angle brackets removed; null when it is not an address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().replace(/^mailto:/i, "").replace(/^<|>$/g, "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : null;
}

/** +<country><number> where the number says or is a 10-digit North American
 *  number (+1 assumed, as the directory stores them); else the digits. */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  let s = String(raw).trim().replace(/\s*(ext\.?|extension|x|#)\s*\d+\s*$/i, "");
  const plus = s.startsWith("+") || s.startsWith("00");
  if (s.startsWith("00")) s = s.slice(2);
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (plus) return `+${digits}`;
  if (digits.length === 10 && /^[2-9]\d{2}[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && /^1[2-9]\d{2}[2-9]/.test(digits)) return `+${digits}`;
  return digits;
}

const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|aol|icloud|me|mac|protonmail|proton|pm|gmx|mail|yandex|qq|163|126|sina|foxmail|zoho|fastmail|hey|tutanota|tuta|rediffmail|comcast|verizon|att|sbcglobal|bellsouth|cox|charter|earthlink|naver|daum|hanmail|web|t-online|free|orange|laposte|libero|seznam|wp|o2|inbox|rambler|bk|list)\.[a-z.]+$/;
/** The label a source gives, else what the domain says: a free-mail domain is
 *  personal, a university domain academic, any other domain business. */
export function emailLabel(type: unknown, address: string): ContactLabel {
  const t = typeof type === "string" ? type.trim().toLowerCase() : "";
  if (t === "personal") return "personal";
  if (t === "business" || t === "work" || t === "professional" || t === "company") return "business";
  if (t === "academic" || t === "edu" || t === "school" || t === "education") return "academic";
  const domain = address.split("@")[1] || "";
  if (FREE_MAIL.test(domain)) return "personal";
  if (/(^|\.)edu$|\.edu\.[a-z]{2}$|\.ac\.[a-z]{2}$/.test(domain)) return "academic";
  return domain ? "business" : "unknown";
}

/** A verifier's verdict as a contact status: bad, invalid or disposable is invalid. */
export function statusFromCheck(quality: unknown, result: unknown): ContactStatus {
  const q = typeof quality === "string" ? quality.toLowerCase() : "";
  const r = typeof result === "string" ? result.toLowerCase() : "";
  if (q === "bad" || r === "invalid" || r === "disposable") return "invalid";
  if (r === "bounced" || r === "bounce") return "bounced";
  return "active";
}

/** A contact with no verification; the caller fills what it knows. */
function contactBase(kind: PersonContact["kind"], raw: unknown, value_normalized: string, label: ContactLabel): PersonContact {
  return {
    kind,
    value_raw: String(raw).trim(),
    value_normalized,
    label,
    status: "active",
    never_primary: false,
    is_manual: false,
    source_detail: null,
    quality: null,
    result: null,
    resultcode: null,
    subresult: null,
    verifier: null,
    verified_at: null,
    legacy_email_id: null,
    legacy_email_ids: [],
  };
}

/** An e-mail contact, or null when there is no text. Text that has an "@"
 *  but is not an address ("first last@example.com") is kept, marked invalid
 *  with result 'not_an_address', so every value a source held is accounted
 *  for and none is ever made primary. */
export function emailContact(raw: unknown, fields: Partial<PersonContact> = {}): PersonContact | null {
  const value_normalized = normalizeEmail(raw);
  if (value_normalized) return { ...contactBase("email", raw, value_normalized, emailLabel(null, value_normalized)), ...fields };
  const text = typeof raw === "string" ? raw.trim().replace(/^mailto:/i, "").trim().toLowerCase() : "";
  if (!text.includes("@") || text.length > 254) return null;
  return { ...contactBase("email", raw, text, "unknown"), ...fields, status: "invalid", result: "not_an_address", quality: null };
}

/** A phone contact, or null when the text holds no number. */
export function phoneContact(raw: unknown, fields: Partial<PersonContact> = {}): PersonContact | null {
  const value_normalized = normalizePhone(raw);
  return value_normalized ? { ...contactBase("phone", raw, value_normalized, "unknown"), ...fields } : null;
}

export function githubContact(raw: unknown, fields: Partial<PersonContact> = {}): PersonContact | null {
  const s = clean(raw);
  if (!s) return null;
  const m = s.match(/github\.com\/([A-Za-z0-9-]+)/i);
  const handle = (m ? m[1] : s.replace(/^@/, "")).toLowerCase();
  if (!/^[a-z0-9-]{1,39}$/.test(handle)) return null;
  return { ...contactBase("github", s, handle, "unknown"), ...fields };
}

const DETAIL_RANK = (c: PersonContact): number => (c.is_manual ? 0 : c.source_detail === "directory_primary" ? 1 : /:primary$/.test(c.source_detail || "") ? 2 : 3);
const NEGATIVE: ContactStatus[] = ["removed", "do_not_use", "bounced"];
/** One contact per (kind, normalized value), in first-seen order. The newest
 *  check wins (verified_at); a recruiter's own entry decides its status; a
 *  sync's bounce or do-not-use stands; an address typed on a form is only
 *  'claimed' when nothing more trusted also holds it. */
export function mergeContacts(list: (PersonContact | null | undefined)[]): PersonContact[] {
  const groups = new Map<string, PersonContact[]>();
  for (const c of list) {
    if (!c) continue;
    const k = `${c.kind}|${c.value_normalized}`;
    const g = groups.get(k) ?? [];
    g.push(c);
    groups.set(k, g);
  }
  const out: PersonContact[] = [];
  for (const g of groups.values()) {
    const first = g[0];
    const checked = g.filter((c) => c.quality || c.result || c.verified_at);
    const newest = checked.sort((a, b) => String(b.verified_at ?? "").localeCompare(String(a.verified_at ?? "")))[0] ?? null;
    const manual = g.find((c) => c.is_manual) ?? null;
    const best = [...g].sort((a, b) => DETAIL_RANK(a) - DETAIL_RANK(b))[0];
    const ids = [...new Set(g.flatMap((c) => [...c.legacy_email_ids, ...(c.legacy_email_id ? [c.legacy_email_id] : [])]))];
    let status: ContactStatus;
    if (manual) status = manual.status;
    else if (g.some((c) => NEGATIVE.includes(c.status))) status = g.find((c) => NEGATIVE.includes(c.status))!.status;
    else if (newest && newest.status === "invalid") status = "invalid";
    else if (g.every((c) => c.status === "claimed")) status = "claimed";
    else status = "active";
    out.push({
      ...first,
      label: g.find((c) => c.label !== "unknown")?.label ?? first.label,
      status,
      never_primary: g.every((c) => c.never_primary),
      is_manual: !!manual,
      source_detail: best.source_detail,
      quality: newest?.quality ?? null,
      result: newest?.result ?? null,
      resultcode: newest?.resultcode ?? null,
      subresult: newest?.subresult ?? null,
      verifier: newest?.verifier ?? null,
      verified_at: newest?.verified_at ?? null,
      legacy_email_id: ids[0] ?? null,
      legacy_email_ids: ids,
    });
  }
  return out;
}

/** Contacts in the order the writer ranks them (the save_person rule), for
 *  checks and the before/after page: the recruiter's choice, the directory's
 *  primary, verified personal, verified business, risky, unverified; never
 *  an invalid, claimed, removed or never-primary one. Phones: recruiter,
 *  directory, mobile, the rest. Ties go to the address the old tables
 *  marked primary (source_detail ending ':primary'), then to the first
 *  seen. The SQL's rank is the authority. */
export function rankedContacts(contacts: PersonContact[], kind: "email" | "phone"): PersonContact[] {
  const eligible = contacts.filter((c) => c.kind === kind && c.status === "active" && !c.never_primary);
  const good = (c: PersonContact) => ["good", "ok"].includes(String(c.quality).toLowerCase()) && !["catch_all", "unknown", "risky"].includes(String(c.result).toLowerCase());
  const risky = (c: PersonContact) => ["risky", "unknown"].includes(String(c.quality).toLowerCase()) || ["catch_all", "unknown", "risky"].includes(String(c.result).toLowerCase());
  const score = (c: PersonContact): number => {
    if (c.is_manual) return 0;
    if (kind === "phone") return String(c.source_detail || "").startsWith("directory") ? 1 : c.label === "mobile" ? 2 : 3;
    if (c.source_detail === "directory_primary") return 1;
    if (good(c) && c.label === "personal") return 2;
    if (good(c)) return 3;
    if (risky(c)) return 4;
    return 5;
  };
  // Among equals, the address the old tables marked primary first (what the Network shows today), then first seen.
  const legacyPrimary = (c: PersonContact) => (/:primary$/.test(c.source_detail || "") ? 0 : 1);
  return eligible
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => a.s - b.s || legacyPrimary(a.c) - legacyPrimary(b.c) || a.i - b.i)
    .map((x) => x.c);
}

// ---------- the source record ----------

/** sha256 of the doc's content (everything but the source record) and its
 *  source kind, reference and fetched_at. The same input twice gives the
 *  same hash; a changed parse of the same payload gives a new one. */
export function payloadHash(doc: Omit<PersonDoc, "source">, source: { source: string; source_ref: string | null; fetched_at: string }): string {
  return sha256(stableStringify({ content: doc, source: source.source, ref: source.source_ref, at: source.fetched_at, v: PARSER_VERSION }));
}

/** ISO timestamp, or null. */
export function isoOf(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** ISO 3166 alpha-2 in upper case, or null. */
export const countryCodeOf = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : null;
};

/** A LinkedIn member's account id as the scrapers give it ("ACoAA..."): it
 *  does not change when the username does. Anything else is null. */
export function linkedinUrnOf(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().replace(/^urn:li:(fsd_profile|member|person):/i, "") : "";
  return /^ACo[A-Za-z0-9_-]{10,}$/.test(s) ? s : null;
}

/** LinkedIn username from a profile URL (/in/<name>), lower case. */
export function linkedinUsernameOf(url: unknown): string | null {
  const m = typeof url === "string" ? url.match(/linkedin\.com\/in\/([^/?#\s]+)/i) : null;
  const u = m ? safeDecode(m[1]).trim().toLowerCase() : "";
  return u || null;
}

/** Build a job with its company identity and row key. */
export function makeJob(p: Omit<PersonJob, "row_key" | "is_side_role" | "sort_order"> & { sort_order?: number }): PersonJob {
  const job: PersonJob = {
    ...p,
    is_side_role: isSideRole(p.title, p.company.name),
    sort_order: p.sort_order ?? 0,
    row_key: "",
  };
  job.row_key = jobRowKey(job.company.identity, job.title, job.start_year, job.start_month);
  return job;
}

/** Order (real job first), number and de-duplicate a list of jobs. */
export function finishJobs(jobs: PersonJob[]): { jobs: PersonJob[]; duplicates: number } {
  const kept = jobs.filter((j) => j.title || j.company.name || j.company.identity);
  const ordered = realJobFirst(kept);
  const { rows, duplicates } = dedupeRowKeys(ordered, (j) =>
    stableStringify([j.title, j.company.identity, j.start_year, j.start_month, j.end_year, j.end_month, j.is_current, j.location, j.description])
  );
  return { jobs: rows.map((j, i) => ({ ...j, sort_order: i })), duplicates };
}

/** Build an education row with its row key. */
export function makeEducation(p: Omit<PersonEducation, "row_key" | "degree_level" | "sort_order"> & { sort_order?: number }): PersonEducation {
  const e: PersonEducation = { ...p, degree_level: degreeLevel(p.degree), sort_order: p.sort_order ?? 0, row_key: "" };
  e.row_key = eduRowKey(e.school.identity, e.degree, e.start_year);
  return e;
}

export function finishEducations(edus: PersonEducation[]): { educations: PersonEducation[]; duplicates: number } {
  const { rows, duplicates } = dedupeRowKeys(edus, (e) =>
    stableStringify([e.school.identity, e.degree, e.field_of_study, e.start_year, e.end_year, e.description, e.activities])
  );
  return { educations: rows.map((e, i) => ({ ...e, sort_order: i })), duplicates };
}

/** Header with every field present (null when unknown). */
export function makeHeader(h: Partial<Record<keyof PersonHeader, unknown>>): PersonHeader {
  return {
    full_name: clean(h.full_name),
    headline: clean(h.headline),
    summary: cleanLong(h.summary),
    location: clean(h.location),
    location_country: countryCodeOf(h.location_country),
    photo: clean(h.photo),
    open_to_work: typeof h.open_to_work === "boolean" ? h.open_to_work : null,
  };
}

/** The doc with its source record completed (payload hash, parser version)
 *  and one identity per (kind, value). */
export function assembleDoc(args: {
  candidate_id: string;
  mode: PersonDoc["mode"];
  source: Omit<PersonSource, "payload_hash" | "parser_version">;
  identities: (PersonIdentity | null | undefined)[];
  header: PersonHeader;
  jobs?: PersonJob[];
  educations?: PersonEducation[];
  skills?: PersonSkill[];
  contacts?: PersonContact[];
}): PersonDoc {
  if (!args.candidate_id) throw new Error("person doc needs a candidate_id");
  const seen = new Set<string>();
  const identities = args.identities.filter((i): i is PersonIdentity => {
    if (!i || !i.value) return false;
    const k = `${i.kind}|${i.value}`;
    return !seen.has(k) && !!seen.add(k);
  });
  const content: Omit<PersonDoc, "source"> = {
    candidate_id: args.candidate_id,
    mode: args.mode,
    identities,
    header: args.header,
    jobs: args.jobs ?? [],
    educations: args.educations ?? [],
    skills: args.skills ?? [],
    contacts: args.contacts ?? [],
  };
  const source: PersonSource = { ...args.source, payload_hash: payloadHash(content, args.source), parser_version: PARSER_VERSION };
  return { candidate_id: content.candidate_id, mode: content.mode, source, identities, header: content.header, jobs: content.jobs, educations: content.educations, skills: content.skills, contacts: content.contacts };
}

/** Runs a converter that caps its input at 25 items and treats item 0 as
 *  special (poolExperiences, harvestToExperiences: "no end date on the first
 *  position means current") over a whole list: the first 25 as they are,
 *  every later slice behind one placeholder that is dropped, so a later item
 *  is never read as the first. The converters are reused, not copied. */
export function uncapped<T, R>(list: T[], convert: (items: T[]) => R[], placeholder: T, cap = 25): R[] {
  const out = convert(list.slice(0, cap));
  for (let i = cap; i < list.length; i += cap - 1) out.push(...convert([placeholder, ...list.slice(i, i + cap - 1)]).slice(1));
  return out;
}

// Contact details pulled from a resume. The LLM profile parse asks for
// phone/email too; this is the deterministic path — the backstop when the
// model wasn't consulted (or, for phone, missed the contact block), and the
// only path for drawer uploads (which never call the model). Conservative by
// design: a wrong number in the contact block is worse than an empty one, so
// anything that looks like a date, an ID, an ISBN or an address is rejected,
// and a number never crosses a line break.
import { sbRest } from "./supabase";

/** Same rule the drawer's contact editor enforces (candidates-unified). */
const PHONE_CHARS = /^[\d\s()+.\-#ext]*$/i;
const KEYWORD = /(?:phone|tel|mobile|mob|cell|call|whatsapp|\bm\b|\bt\b|\bp\b)\s*[:.]?\s*$/i;
const EXT = /\s*(?:ext\.?|x|#)\s*(\d{1,6})\s*$/i;

/** Normalise a candidate phone string to the stored form, or null when it
 *  can't be a phone number at all. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, " ").trim();
  s = s.replace(/[\s.,;:|]+$/g, "").replace(/^[\s.,;:|]+/g, "");
  if (!s || s.length > 40 || !PHONE_CHARS.test(s)) return null;
  // An extension rides along; judge the number without it.
  let ext = "";
  const em = s.match(EXT);
  if (em) {
    ext = ` ext ${em[1]}`;
    s = s.slice(0, em.index).trim();
  }
  if (/[a-z]/i.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return null;
  const groups = s.split(/[\s\-–.]+/).filter(Boolean);
  const lead = /^[+(0]/.test(s);
  // Date columns ("2019 2021 2023") and single years with digits glued on.
  if (groups.length > 1 && groups.every((g) => /^(19|20)\d{2}$/.test(g))) return null;
  if (!lead && /^(19|20)\d{2}/.test(digits) && groups.length === 1) return null;
  // Without a country/trunk lead only a national 10–11 digit shape reads as
  // a phone (SSNs, Aadhaar, order numbers and bare 9-digit IDs do not).
  if (!lead && (digits.length < 10 || digits.length > 11)) return null;
  // A complete number followed by a year on the same line ("020 7946 0958 2021").
  const yearTail = s.match(/^(.*\d)\s+(19|20)\d{2}$/);
  if (yearTail && groups.length >= 3) {
    const rest = yearTail[1];
    const rd = rest.replace(/\D/g, "").length;
    if (/^[+(0]/.test(rest) && rd >= 10) {
      const shorter = normalizePhone(rest);
      if (shorter) return shorter + ext;
    }
  }
  // IPv4 and dotted version-like shapes.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  // ISBN-13 / ISBN-10: a 978/979 prefix, or hyphenated groups ending in a lone check digit.
  if (/^97[89][\s-]/.test(s)) return null;
  if (!lead && groups.length >= 4 && /^\d$|^X$/i.test(groups[groups.length - 1])) return null;
  if (groups.length > 7) return null;
  return s + ext;
}

/** Try the run, then progressively fewer trailing groups (a phone followed
 *  by a year or a house number on the same line). */
function bestPrefix(run: string): string | null {
  const direct = normalizePhone(run);
  if (direct) return direct;
  const parts = run.trim().split(/\s+/);
  for (let n = parts.length - 1; n >= 2; n--) {
    const v = normalizePhone(parts.slice(0, n).join(" "));
    if (v) return v;
  }
  return null;
}

/** First plausible phone number in the text, preferring ones introduced by
 *  a "Phone:" / "Mobile:" label and ones near the top (the contact block).
 *  Works line by line: a number never absorbs the next line. */
export function extractPhone(text: string | null | undefined): string | null {
  if (!text) return null;
  const src = text.slice(0, 20000);
  const re = /\+?\(?\d[\d ().\-\t]{7,26}\d(?:\s*(?:ext\.?|x|#)\s*\d{1,6})?/gi;
  let best: { value: string; score: number } | null = null;
  let offset = 0;
  for (const line of src.split("\n")) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      // A slash, hyphen or letter right before the digits means a URL slug,
      // an ID or a word, not a number.
      const prev = m.index > 0 ? line[m.index - 1] : "";
      if (/[A-Za-z0-9/\-_#]/.test(prev)) continue;
      const value = bestPrefix(m[0]);
      if (!value) continue;
      const before = line.slice(Math.max(0, m.index - 16), m.index);
      let score = 0;
      if (KEYWORD.test(before)) score += 3;
      if (/^\+/.test(value)) score += 2;
      else if (/^0\d/.test(value) || /^\(/.test(value)) score += 1;
      if (offset + m.index < 1500) score += 1;
      if (!best || score > best.score) best = { value, score };
    }
    offset += line.length + 1;
  }
  return best ? best.value : null;
}

/** Every distinct email in the text (document order), minus the excluded
 *  (primary) address. Callers pick the first one they don't already know. */
export function extractEmails(text: string | null | undefined, exclude?: string | null): string[] {
  if (!text) return [];
  const ex = (exclude || "").trim().toLowerCase();
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text.slice(0, 20000)))) {
    const e = m[0].replace(/[.,;:]+$/, "");
    const k = e.toLowerCase();
    if (e.length > 160 || k === ex || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

/** First email in the text that isn't the excluded (primary) address. */
export function extractEmail(text: string | null | undefined, exclude?: string | null): string | null {
  return extractEmails(text, exclude)[0] || null;
}

/** Plain text of a PDF via pdf-parse (no network, no cost). maxPages bounds
 *  the work — the contact block is on the first page or two. */
export async function pdfText(buf: Buffer, maxPages = 0): Promise<string> {
  try {
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdf = (mod.default || mod) as (b: Buffer, o?: { max?: number }) => Promise<{ text: string }>;
    const out = await pdf(buf, maxPages > 0 ? { max: maxPages } : undefined);
    return String(out.text || "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
      .trim()
      .slice(0, 60000);
  } catch (err) {
    console.error("pdf extraction failed", err);
    return "";
  }
}

export type Contact = {
  email?: string | null;
  phone?: string | null;
  github?: string | null;
  otherEmails?: string[] | null;
};

type Row = { contact: Contact | null; email?: string | null; linkedin_username?: string | null; organization_id?: string | null };

/** The other half of a person's record: an applicant's sourced row (or a
 *  sourced person's application) in the same org, matched the way the
 *  candidate detail merges them — by LinkedIn username. */
async function linkedRow(key: string, row: Row): Promise<Row | null> {
  const u = row.linkedin_username;
  const org = row.organization_id;
  if (!u || !org) return null;
  const path = key.startsWith("app_")
    ? `sourced_candidates?organization_id=eq.${org}&linkedin_username=eq.${encodeURIComponent(u)}&select=contact&limit=1`
    : `website_applications?organization_id=eq.${org}&linkedin_username=eq.${encodeURIComponent(u)}&select=contact,email&order=created_at.desc&limit=1`;
  const res = await sbRest(path).catch(() => null);
  if (!res || !res.ok) return null;
  const [r] = (await res.json()) as Row[];
  return r || null;
}

/** Fill gaps in a candidate's contact block from what a resume yielded.
 *  Never overwrites: a phone typed by a recruiter on EITHER half of the
 *  person's record wins over an extracted one, and an extracted email only
 *  lands in otherEmails when it isn't the primary or already listed. The
 *  phone write is conditional at the database, so a recruiter saving the
 *  contact block at the same moment can't be clobbered. Returns what
 *  changed ({ phone?, otherEmails? }) or null when nothing did. */
export async function fillExtractedContact(
  key: string,
  found: { phone?: string | null; email?: string | null; emails?: string[] },
  orgId?: string | null
): Promise<{ phone?: string | null; otherEmails?: string[] } | null> {
  const phone = normalizePhone(found.phone);
  const emails = [...(found.emails || []), ...(found.email ? [found.email] : [])]
    .map((e) => e.trim())
    .filter((e) => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 160);
  if (!phone && !emails.length) return null;

  const scope = orgId ? `&organization_id=eq.${orgId}` : "";
  const isApp = key.startsWith("app_");
  const isSrc = key.startsWith("src_");
  if (!isApp && !isSrc) return null;
  const id = key.slice(4);
  const table = isSrc ? "sourced_candidates" : "website_applications";
  const cols = isSrc ? "contact,linkedin_username,organization_id" : "contact,email,linkedin_username,organization_id";

  const res = await sbRest(`${table}?id=eq.${id}${scope}&select=${cols}`);
  if (!res.ok) return null;
  const [row] = (await res.json()) as Row[];
  if (!row) return null;
  const other = await linkedRow(key, row);

  const current: Contact = { ...(row.contact || {}) };
  // The primary the dashboard shows: the application's typed/primary email
  // wins over the sourced record's, whichever half we were asked to fill.
  const appHalf = isApp ? row : other;
  const srcHalf = isSrc ? row : other;
  const primary = (
    appHalf?.contact?.email || srcHalf?.contact?.email || appHalf?.email || ""
  ).toLowerCase();
  const known = new Set<string>([primary]);
  for (const r of [row, other]) {
    for (const e of r?.contact?.otherEmails || []) known.add(e.toLowerCase());
    if (r?.contact?.email) known.add(r.contact.email.toLowerCase());
    if (r?.email) known.add(r.email.toLowerCase());
  }
  const hasPhone = Boolean((row.contact?.phone || "").trim() || (other?.contact?.phone || "").trim());

  const change: { phone?: string | null; otherEmails?: string[] } = {};
  if (phone && !hasPhone) {
    current.phone = phone;
    change.phone = phone;
  }
  const extra = emails.find((e) => !known.has(e.toLowerCase()));
  if (extra) {
    const others = [...(current.otherEmails || []), extra].slice(0, 8);
    if (others.length !== (current.otherEmails || []).length) {
      current.otherEmails = others;
      change.otherEmails = others;
    }
  }
  if (!change.phone && !change.otherEmails) return null;

  // Conditional write: when filling the phone, only touch a row whose phone
  // is still empty — a concurrent recruiter save wins.
  const guard = change.phone ? `&or=(contact.is.null,contact->>phone.is.null,contact->>phone.eq.)` : "";
  const put = await sbRest(`${table}?id=eq.${id}${scope}${guard}`, {
    method: "PATCH",
    body: JSON.stringify({ contact: current }),
    prefer: "return=representation",
  });
  if (!put.ok) return null;
  const rows = (await put.json()) as unknown[];
  return rows.length ? change : null;
}

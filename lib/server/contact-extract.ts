// Contact details pulled from a resume. The LLM profile parse asks for
// phone/email too; this is the deterministic path — the fallback when the
// model returns nothing, and the only path for drawer uploads (which never
// call the model). Conservative by design: a wrong number in the contact
// block is worse than an empty one, so anything that looks like a date
// column or an ID is rejected.
import { sbRest } from "./supabase";

/** Same rule the drawer's contact editor enforces (candidates-unified). */
const PHONE_CHARS = /^[\d\s()+.\-#ext]*$/i;

const KEYWORD = /(?:phone|tel|mobile|mob|cell|call|whatsapp|\bm\b|\bt\b|\bp\b)\s*[:.]?\s*$/i;

/** Normalise a candidate phone string to the stored form, or null when it
 *  can't be a phone number at all. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, " ").trim();
  // Trailing punctuation from sentence context ("call me on 0770… .").
  s = s.replace(/[\s.,;:|]+$/g, "").replace(/^[\s.,;:|]+/g, "");
  if (!s || s.length > 40 || !PHONE_CHARS.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return null;
  // All-year groups ("2019 2021 2023") are date columns, not numbers.
  const groups = s.split(/[\s\-–.]+/).filter(Boolean);
  if (groups.length > 1 && groups.every((g) => /^(19|20)\d{2}$/.test(g))) return null;
  // A single run of digits with a year prefix and no + / 0 lead is an ID.
  if (!/^[+(0]/.test(s) && /^(19|20)\d{2}/.test(digits) && groups.length === 1) return null;
  // Bare 12+ digit runs without a country/trunk lead are order numbers,
  // not phones; five-plus separated groups are ISBNs / references.
  if (groups.length === 1 && !/^[+(0]/.test(s) && digits.length > 11) return null;
  if (groups.length > 4) return null;
  return s;
}

/** First plausible phone number in the text, preferring ones introduced by
 *  a "Phone:" / "Mobile:" label and ones near the top (the contact block). */
export function extractPhone(text: string | null | undefined): string | null {
  if (!text) return null;
  const src = text.slice(0, 20000);
  const re = /\+?\(?\d[\d\s().\-]{7,22}\d/g;
  let best: { value: string; score: number; at: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const value = normalizePhone(m[0]);
    if (!value) continue;
    const before = src.slice(Math.max(0, m.index - 16), m.index);
    let score = 0;
    if (KEYWORD.test(before)) score += 3;
    if (/^\+/.test(value)) score += 2;
    else if (/^0\d/.test(value) || /^\(/.test(value)) score += 1;
    if (m.index < 1500) score += 1;
    if (!best || score > best.score) best = { value, score, at: m.index };
  }
  return best ? best.value : null;
}

/** First email in the text that isn't the excluded (primary) address. */
export function extractEmail(text: string | null | undefined, exclude?: string | null): string | null {
  if (!text) return null;
  const ex = (exclude || "").trim().toLowerCase();
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text.slice(0, 20000)))) {
    const e = m[0].replace(/[.,;:]+$/, "");
    if (e.length > 160) continue;
    if (e.toLowerCase() === ex) continue;
    return e;
  }
  return null;
}

/** Plain text of a PDF via pdf-parse (no network, no cost). */
export async function pdfText(buf: Buffer): Promise<string> {
  try {
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdf = (mod.default || mod) as (b: Buffer) => Promise<{ text: string }>;
    const out = await pdf(buf);
    return String(out.text || "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
      .trim()
      .slice(0, 60000);
  } catch (err) {
    console.error("pdf extraction failed", err);
    return "";
  }
}

type Contact = {
  email?: string | null;
  phone?: string | null;
  github?: string | null;
  otherEmails?: string[] | null;
};

/** Fill gaps in a candidate's contact block from what a resume yielded.
 *  Never overwrites: a phone typed by a recruiter wins over an extracted
 *  one, and an extracted email only ever lands in otherEmails when it
 *  differs from the primary. Returns the stored contact, or null when
 *  nothing changed / the row wasn't found. */
export async function fillExtractedContact(
  key: string,
  found: { phone?: string | null; email?: string | null },
  orgId?: string | null
): Promise<Contact | null> {
  const phone = normalizePhone(found.phone);
  const email = (found.email || "").trim();
  if (!phone && !email) return null;

  const scope = orgId ? `&organization_id=eq.${orgId}` : "";
  const table = key.startsWith("src_")
    ? `sourced_candidates?id=eq.${key.slice(4)}${scope}&select=contact`
    : key.startsWith("app_")
      ? `website_applications?id=eq.${key.slice(4)}${scope}&select=contact,email`
      : null;
  if (!table) return null;

  const res = await sbRest(table);
  if (!res.ok) return null;
  const [row] = (await res.json()) as { contact: Contact | null; email?: string | null }[];
  if (!row) return null;

  const current: Contact = { ...(row.contact || {}) };
  const primary = (current.email || row.email || "").toLowerCase();
  let changed = false;

  if (phone && !(current.phone || "").trim()) {
    current.phone = phone;
    changed = true;
  }
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 160) {
    const known = new Set([primary, ...(current.otherEmails || []).map((e) => e.toLowerCase())]);
    if (!known.has(email.toLowerCase())) {
      const others = [...(current.otherEmails || []), email].slice(0, 8);
      if (others.length !== (current.otherEmails || []).length) {
        current.otherEmails = others;
        changed = true;
      }
    }
  }
  if (!changed) return null;

  const target = table.split("&select=")[0];
  const put = await sbRest(target, {
    method: "PATCH",
    body: JSON.stringify({ contact: current }),
    prefer: "return=minimal",
  });
  return put.ok ? current : null;
}

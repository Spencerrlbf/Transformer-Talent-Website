// Building HTML (emails) out of text that came from outside: a form field, a
// company name, a job title. Such text is always shown as text, never read
// as markup, and a link is only ever one we built from a checked value.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text for an HTML body or a quoted attribute value. */
export const escapeHtml = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** A subject line: plain text on one line, capped. */
export const plainLine = (v: unknown, max = 200): string =>
  String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** A LinkedIn profile link rebuilt from the profile name in whatever was
 *  typed ("linkedin.com/in/<name>"), or null. What was typed is never used
 *  as the link itself. */
export function linkedinHref(v: unknown): string | null {
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(String(v ?? ""));
  if (!m) return null;
  let name = m[1];
  try {
    name = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (!/^[\p{L}\p{N}._-]{2,100}$/u.test(name)) return null;
  return `https://www.linkedin.com/in/${encodeURIComponent(name.toLowerCase())}`;
}

/** An email address fit for a mailto: link, or null. */
export function mailtoHref(v: unknown): string | null {
  const e = String(v ?? "").trim();
  return /^[^\s<>"'(),;:@\\]+@[^\s<>"'(),;:@\\]+\.[^\s<>"'(),;:@\\]+$/.test(e) && e.length <= 254
    ? `mailto:${e}`
    : null;
}

/** JSON for a <script type="application/ld+json"> block: "<" escaped so the
 *  data can never close the script tag. */
export const jsonForScript = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");

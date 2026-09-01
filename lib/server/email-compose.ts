// Send-as-you email: everything between the Nylas wire (nylas.ts) and the
// routes. Connections, org-shared templates, the compose context (merge
// values incl. the candidate's tracked link), HTML sanitizing, the per-
// candidate log, and reply matching for the webhook.
import { randomUUID } from "crypto";
import { sbRest, sbInsert } from "./supabase";
import { ensureLinks } from "./tracked-links";

const KEY_RE = /^(app|src)_[0-9a-f-]{36}$/i;

// ---- connected accounts ----------------------------------------------

export type EmailAccount = {
  grantId: string;
  address: string;
  provider: string;
};

export async function accountFor(orgId: string, memberEmail: string): Promise<EmailAccount | null> {
  const res = await sbRest(
    `email_accounts?organization_id=eq.${orgId}&member_email=eq.${encodeURIComponent(
      memberEmail
    )}&select=grant_id,address,provider&limit=1`
  );
  if (!res.ok) return null;
  const [row] = (await res.json()) as { grant_id: string; address: string; provider: string }[];
  return row ? { grantId: row.grant_id, address: row.address, provider: row.provider } : null;
}

export async function saveAccount(args: {
  orgId: string;
  memberEmail: string;
  grantId: string;
  address: string;
  provider: string;
}): Promise<boolean> {
  const res = await sbRest(`email_accounts?on_conflict=organization_id,member_email`, {
    method: "POST",
    prefer: "resolution=merge-duplicates",
    body: JSON.stringify({
      organization_id: args.orgId,
      member_email: args.memberEmail,
      grant_id: args.grantId,
      address: args.address,
      provider: args.provider,
    }),
  });
  return res.ok;
}

export async function removeAccount(orgId: string, memberEmail: string): Promise<string | null> {
  const existing = await accountFor(orgId, memberEmail);
  if (!existing) return null;
  await sbRest(
    `email_accounts?organization_id=eq.${orgId}&member_email=eq.${encodeURIComponent(memberEmail)}`,
    { method: "DELETE" }
  );
  return existing.grantId;
}

/** All seats bound to a grant. Nylas dedupes grants per app+mailbox, so a
 *  shared inbox connected by several seats (or orgs) yields several rows
 *  with the same grant_id — the webhook must serve every one of them, and
 *  disconnect must only revoke the grant once no row references it. */
export async function accountsByGrant(
  grantId: string
): Promise<{ orgId: string; memberEmail: string; address: string }[]> {
  const res = await sbRest(
    `email_accounts?grant_id=eq.${encodeURIComponent(grantId)}&select=organization_id,member_email,address&limit=20`
  );
  if (!res.ok) return [];
  return ((await res.json()) as { organization_id: string; member_email: string; address: string }[]).map(
    (row) => ({ orgId: row.organization_id, memberEmail: row.member_email, address: row.address })
  );
}

// ---- templates --------------------------------------------------------

export type Template = {
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
};

const TPL_COLS = "id,name,subject,body_html";
const shapeTpl = (t: { id: string; name: string; subject: string; body_html: string }): Template => ({
  id: t.id,
  name: t.name,
  subject: t.subject,
  bodyHtml: t.body_html,
});

export async function listTemplates(orgId: string): Promise<Template[]> {
  const res = await sbRest(
    `email_templates?organization_id=eq.${orgId}&select=${TPL_COLS}&order=created_at.asc&limit=100`
  );
  return res.ok
    ? ((await res.json()) as Parameters<typeof shapeTpl>[0][]).map(shapeTpl)
    : [];
}

export async function createTemplate(args: {
  orgId: string;
  name: string;
  subject: string;
  bodyHtml: string;
  byEmail: string;
}): Promise<Template | { error: string }> {
  const name = args.name.trim().slice(0, 80);
  if (!name) return { error: "bad_name" };
  const row = await sbInsert<Parameters<typeof shapeTpl>[0]>(
    "email_templates",
    {
      organization_id: args.orgId,
      name,
      subject: args.subject.slice(0, 300),
      body_html: sanitizeEmailHtml(args.bodyHtml),
      created_by_email: args.byEmail,
    },
    true
  ).catch(() => null);
  return row ? shapeTpl(row) : { error: "duplicate_name" };
}

export async function updateTemplate(args: {
  orgId: string;
  id: string;
  name: string;
  subject: string;
  bodyHtml: string;
}): Promise<boolean> {
  const res = await sbRest(`email_templates?id=eq.${args.id}&organization_id=eq.${args.orgId}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: args.name.trim().slice(0, 80),
      subject: args.subject.slice(0, 300),
      body_html: sanitizeEmailHtml(args.bodyHtml),
      updated_at: new Date().toISOString(),
    }),
  });
  return res.ok;
}

export async function deleteTemplate(orgId: string, id: string): Promise<boolean> {
  const res = await sbRest(`email_templates?id=eq.${id}&organization_id=eq.${orgId}`, {
    method: "DELETE",
  });
  return res.ok;
}

// ---- candidate contact ------------------------------------------------

export async function candidateContact(
  orgId: string,
  key: string
): Promise<{ name: string; email: string | null } | null> {
  if (!KEY_RE.test(key)) return null;
  const id = key.slice(4);
  if (key.startsWith("app_")) {
    const res = await sbRest(
      `website_applications?id=eq.${id}&organization_id=eq.${orgId}&select=name,email&limit=1`
    );
    const [row] = res.ok ? ((await res.json()) as { name: string; email: string | null }[]) : [];
    return row ? { name: row.name || "", email: row.email || null } : null;
  }
  const res = await sbRest(
    `sourced_candidates?id=eq.${id}&organization_id=eq.${orgId}&select=full_name,contact&limit=1`
  );
  const [row] = res.ok
    ? ((await res.json()) as { full_name: string; contact: { email?: string | null } | null }[])
    : [];
  return row ? { name: row.full_name || "", email: row.contact?.email || null } : null;
}

// ---- compose context --------------------------------------------------

export type ComposeJob = {
  id: string;
  title: string;
  company: string;
  salary: string;
  locations: string[];
  workplace: string;
  /** Absolute public JD URL; empty when the org has no public page for it. */
  url: string;
};

const SITE = "https://www.transformertalent.com";

const roleSlugFor = (title: string, jobId: string): string => {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base}-${jobId}`;
};

export async function composeJobs(orgId: string, orgSlug: string): Promise<ComposeJob[]> {
  const res = await sbRest(
    `org_roles?organization_id=eq.${orgId}&status=eq.open&select=external_id,title,salary,locations,workplace,company_name&order=title.asc&limit=200`
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as {
    external_id: string;
    title: string;
    salary: string | null;
    locations: string[] | null;
    workplace: string | null;
    company_name: string | null;
  }[];
  const isTT = orgSlug === "transformer-talent";
  return rows.map((r) => ({
    id: r.external_id,
    title: r.title,
    company: r.company_name || "",
    salary: r.salary || "",
    locations: r.locations || [],
    workplace: r.workplace || "",
    url: isTT ? `${SITE}/roles/${roleSlugFor(r.title, r.external_id)}` : `${SITE}/board/${orgSlug}`,
  }));
}

export async function trackedLinkUrl(
  orgId: string,
  candidateKey: string,
  userId: string
): Promise<string> {
  const links = await ensureLinks({ orgId, candidateKeys: [candidateKey], userId });
  const link = links.get(candidateKey);
  return link ? `${SITE}/l/${link.token}` : "";
}

// ---- HTML sanitizing --------------------------------------------------

// Rebuild-only sanitizer for the small tag set the compose toolbar can
// produce. Every tag is re-emitted from scratch (so no attribute survives
// except a validated href); anything unrecognized is dropped, keeping its
// text. This runs on every template save and every send.
const OK_TAGS = new Set(["b", "strong", "i", "em", "u", "p", "div", "span", "br", "ul", "ol", "li"]);

export function sanitizeEmailHtml(html: string): string {
  return html.slice(0, 100_000).replace(/<[^>]*>?/g, (tag) => {
    if (!tag.endsWith(">")) return "";
    const m = /^<\s*(\/?)\s*([a-zA-Z0-9]+)/.exec(tag);
    if (!m) return "";
    const close = m[1] === "/";
    const name = m[2].toLowerCase();
    if (name === "a") {
      if (close) return "</a>";
      const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      const url = (href?.[1] ?? href?.[2] ?? "").trim();
      if (/^(https?:|mailto:)/i.test(url)) return `<a href="${url.replace(/"/g, "&quot;")}">`;
      return "<a>";
    }
    if (OK_TAGS.has(name)) return close ? `</${name}>` : name === "br" ? "<br>" : `<${name}>`;
    return "";
  });
}

export function htmlToSnippet(html: string, max = 180): string {
  return html
    .replace(/<br\s*\/?\s*>|<\/(p|div|li)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// ---- the log + timeline ----------------------------------------------

export type EmailEvent = {
  id: string;
  direction: "out" | "in";
  memberEmail: string;
  address: string;
  subject: string;
  snippet: string;
  bodyHtml: string | null;
  createdAt: string;
};

type DbLog = {
  id: string;
  direction: "out" | "in";
  member_email: string;
  address: string;
  subject: string;
  snippet: string;
  body_html: string | null;
  created_at: string;
};

const LOG_COLS = "id,direction,member_email,address,subject,snippet,body_html,created_at";

export async function listCandidateEmails(orgId: string, key: string): Promise<EmailEvent[]> {
  if (!KEY_RE.test(key)) return [];
  const res = await sbRest(
    `candidate_email_log?organization_id=eq.${orgId}&candidate_key=eq.${key}&select=${LOG_COLS}&order=created_at.desc&limit=100`
  );
  if (!res.ok) return [];
  return ((await res.json()) as DbLog[]).map((r) => ({
    id: r.id,
    direction: r.direction,
    memberEmail: r.member_email,
    address: r.address,
    subject: r.subject,
    snippet: r.snippet,
    bodyHtml: r.body_html,
    createdAt: r.created_at,
  }));
}

export async function logEmail(args: {
  orgId: string;
  candidateKey: string;
  direction: "out" | "in";
  memberEmail: string;
  address: string;
  subject: string;
  snippet: string;
  bodyHtml?: string | null;
  messageId?: string;
  threadId?: string;
}): Promise<boolean> {
  // ignore-duplicates: a webhook echo of a message we logged at send time
  // hits the (org, message_id) unique index and is dropped. The index is
  // FULL (not partial — PostgREST can't arbitrate on a partial index), so
  // a missing provider id gets a synthetic unique one.
  const res = await sbRest(`candidate_email_log?on_conflict=organization_id,message_id`, {
    method: "POST",
    prefer: "resolution=ignore-duplicates",
    body: JSON.stringify({
      organization_id: args.orgId,
      candidate_key: args.candidateKey,
      direction: args.direction,
      member_email: args.memberEmail,
      address: args.address,
      subject: args.subject.slice(0, 500),
      snippet: args.snippet,
      body_html: args.bodyHtml ?? null,
      message_id: args.messageId || `local-${randomUUID()}`,
      thread_id: args.threadId || "",
    }),
  });
  if (!res.ok) console.error("email log failed", res.status, await res.text().catch(() => ""));
  return res.ok;
}

// ---- webhook reply matching -------------------------------------------

/** Find the org candidate a from-address belongs to, or null — in which
 *  case the message is none of our business and must not be stored. */
export async function matchCandidateByAddress(orgId: string, address: string): Promise<string | null> {
  const addr = address.trim().toLowerCase();
  if (!addr || addr.length > 254) return null;
  // ilike gets case-insensitivity; its two wildcards are escaped, and the
  // result is re-checked in code so no pattern quirk can widen the match.
  const pat = encodeURIComponent(addr.replace(/([%_\\])/g, "\\$1"));
  const [apps, srcs] = await Promise.all([
    sbRest(`website_applications?organization_id=eq.${orgId}&email=ilike.${pat}&select=id,email&limit=1`),
    sbRest(
      `sourced_candidates?organization_id=eq.${orgId}&contact->>email=ilike.${pat}&select=id,contact&limit=1`
    ),
  ]);
  if (apps.ok) {
    const [row] = (await apps.json()) as { id: string; email: string | null }[];
    if (row && (row.email || "").trim().toLowerCase() === addr) return `app_${row.id}`;
  }
  if (srcs.ok) {
    const [row] = (await srcs.json()) as { id: string; contact: { email?: string | null } | null }[];
    if (row && (row.contact?.email || "").trim().toLowerCase() === addr) return `src_${row.id}`;
  }
  return null;
}

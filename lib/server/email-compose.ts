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
    // Contact edits made in the drawer live on the contact jsonb; the email
    // column keeps what the candidate originally applied with. The edited
    // address wins — it's what the drawer shows.
    const res = await sbRest(
      `website_applications?id=eq.${id}&organization_id=eq.${orgId}&select=name,email,contact&limit=1`
    );
    const [row] = res.ok
      ? ((await res.json()) as {
          name: string;
          email: string | null;
          contact: { email?: string | null } | null;
        }[])
      : [];
    return row ? { name: row.name || "", email: row.contact?.email || row.email || null } : null;
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

// ---- reply cleaning ---------------------------------------------------

/** HTML → readable plain text with line structure kept. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

const decodeEntities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (m, n: string) => {
      const cp = Number(n);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => {
      const cp = parseInt(h, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);

export function htmlToText(html: string): string {
  return (
    html
      .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      // Gmail/Apple Mail put the first line as bare text followed by sibling
      // <div>s: an opening block right after text is a line break too.
      .replace(/([^>\n\s])(?=<(?:div|p|li|blockquote|h[1-6]|tr)\b)/gi, "$1\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => decodeEntities(line))
      .join("\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// The quote containers the major clients emit. Quoted history always trails
// the reply, so everything from the container onward goes.
export function stripQuotedHtml(html: string): string {
  return html
    .replace(/<div[^>]*id=["']?(appendonsend|divRplyFwdMsg)["']?[^>]*>[\s\S]*$/i, "")
    .replace(/<div[^>]*class=["'][^"']*gmail_quote[^"']*["'][^>]*>[\s\S]*$/i, "")
    .replace(/<blockquote[\s\S]*$/i, "");
}

// The attribution line starts with a date ("On 1 Sep 2026, at 20:26, …" /
// "On Mon, 1 Sep 2026 at 10:00, …"), which is what keeps a sentence like
// "On Monday I can do a call." from being mistaken for it.
const ON_DATE = String.raw`On\s(?:\d|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s*\d)`;
const QUOTE_MARKERS: RegExp[] = [
  new RegExp(String.raw`(?:^|\n)\s*${ON_DATE}[\s\S]{0,300}?\bwrote:\s*(?:\n|$)`, "i"), // Apple Mail / Gmail / plain
  /(?:^|\n)\s*-{2,}\s*Original Message\s*-{2,}/i,
  /(?:^|\n)\s*From:\s[^\n]+\n\s*(?:Sent|Date):\s[^\n]+/i, // Outlook header block
  /(?:^|\n)\s*_{5,}\s*\n/, // Outlook separator rule
  /(?:^|\n)>\s?[^\n]*(?:\n>[^\n]*)*\s*$/, // trailing ">"-quoted block
];
// For whitespace-collapsed previews (no newlines to anchor on).
const LOOSE_MARKERS: RegExp[] = [
  new RegExp(String.raw`\b${ON_DATE}[^\n]{0,300}?\bwrote:`, "i"),
  /\bFrom:\s[^\n]{1,200}?\b(?:Sent|Date):\s/,
];

/** Split text into the sender's own words and the quoted chain. A marker at
 *  position 0 means the sender wrote nothing (attachment-only reply). */
export function splitQuoted(text: string, loose = false): { own: string; quoted: string } {
  let cut = -1;
  const markers = loose ? [...QUOTE_MARKERS, ...LOOSE_MARKERS] : QUOTE_MARKERS;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut === -1) return { own: text.trim(), quoted: "" };
  return { own: text.slice(0, cut).trim(), quoted: text.slice(cut).trim() };
}

const ATTRIBUTION_ONLY = new RegExp(String.raw`^${ON_DATE}[\s\S]*wrote:$`, "i");

/** Inbound message → its own words plus the quoted chain (kept, not lost). */
export function cleanInbound(bodyHtml: string, fallbackSnippet: string): { own: string; quoted: string } {
  if (!bodyHtml) return splitQuoted(fallbackSnippet, true);
  const full = htmlToText(bodyHtml);
  let own = splitQuoted(htmlToText(stripQuotedHtml(bodyHtml))).own;
  if (!own) own = splitQuoted(full).own;
  // Bottom-posted reply (answer typed under the quote): the strip left only
  // the attribution line, so show everything rather than noise.
  if (!own || ATTRIBUTION_ONLY.test(own)) return { own: full, quoted: "" };
  const quoted = full.startsWith(own) ? full.slice(own.length).trim() : splitQuoted(full).quoted;
  return { own, quoted };
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
  /** The message's own words, quoted history stripped. */
  bodyText: string;
  quotedText: string;
  messageId: string;
  threadId: string;
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
  body_text: string;
  quoted_text: string;
  message_id: string;
  thread_id: string;
  created_at: string;
};

const LOG_COLS =
  "id,direction,member_email,address,subject,snippet,body_html,body_text,quoted_text,message_id,thread_id,created_at";

const shapeLog = (r: DbLog): EmailEvent => ({
  id: r.id,
  direction: r.direction,
  memberEmail: r.member_email,
  address: r.address,
  subject: r.subject,
  snippet: r.snippet,
  bodyHtml: r.body_html,
  // Rows logged before cleaning existed: derive at read time.
  bodyText:
    r.body_text ||
    (r.direction === "out" && r.body_html ? htmlToText(r.body_html) : splitQuoted(r.snippet, true).own),
  quotedText: r.quoted_text,
  messageId: r.message_id,
  threadId: r.thread_id,
  createdAt: r.created_at,
});

export async function listCandidateEmails(orgId: string, key: string): Promise<EmailEvent[]> {
  if (!KEY_RE.test(key)) return [];
  const res = await sbRest(
    `candidate_email_log?organization_id=eq.${orgId}&candidate_key=eq.${key}&select=${LOG_COLS}&order=created_at.desc&limit=200`
  );
  if (!res.ok) return [];
  return ((await res.json()) as DbLog[]).map(shapeLog);
}

export type EmailThread = {
  id: string;
  subject: string;
  messages: EmailEvent[];
  lastAt: string;
  /** The candidate spoke last — the ball is in the recruiter's court. */
  awaiting: boolean;
};

/** Org-wide switch: 'private' = only the mailbox owner sees a thread
 *  (Inbox, Email tab, timeline); 'team' = every member sees every thread. */
export async function orgEmailVisibility(orgId: string): Promise<"private" | "team"> {
  const res = await sbRest(`organizations?id=eq.${orgId}&select=email_visibility`);
  const [row] = res.ok ? ((await res.json()) as { email_visibility: string | null }[]) : [];
  return row?.email_visibility === "team" ? "team" : "private";
}

/** A teammate's message the viewer may not read: enough for a timeline
 *  marker ("Alex emailed · Tue"), never the subject or body. */
export type EmailPrivateMarker = {
  id: string;
  direction: "out" | "in";
  memberEmail: string;
  createdAt: string;
  threadId: string;
};

/** The seats that share the viewer's mailbox. One Nylas grant can be bound
 *  to several seats (a shared recruiting@ inbox); an inbound message is
 *  logged once, under whichever binding the webhook met first, so "my
 *  mailbox" means every member on the same grant, not just my address. */
export async function viewerMailboxEmails(orgId: string, viewer: string): Promise<Set<string>> {
  const out = new Set<string>([viewer]);
  const res = await sbRest(`email_accounts?organization_id=eq.${orgId}&select=member_email,grant_id&limit=200`).catch(() => null);
  if (!res || !res.ok) return out;
  const rows = (await res.json()) as { member_email: string; grant_id: string }[];
  const mine = rows.find((r) => r.member_email === viewer)?.grant_id;
  if (mine) for (const r of rows) if (r.grant_id === mine) out.add(r.member_email);
  return out;
}

/** The one place the privacy rule is applied: what this viewer may read of
 *  a candidate's correspondence, plus markers for what they may not. */
export async function listCandidateEmailsFor(
  orgId: string,
  key: string,
  viewer: string
): Promise<{ events: EmailEvent[]; hidden: EmailPrivateMarker[]; visibility: "private" | "team" }> {
  const [rows, visibility, aliases] = await Promise.all([
    listCandidateEmails(orgId, key),
    orgEmailVisibility(orgId),
    viewerMailboxEmails(orgId, viewer),
  ]);
  if (visibility === "team") return { events: rows, hidden: [], visibility };
  const events = rows.filter((r) => aliases.has(r.memberEmail));
  const hidden = rows
    .filter((r) => !aliases.has(r.memberEmail))
    .map((r) => ({
      id: r.id,
      direction: r.direction,
      memberEmail: r.memberEmail,
      createdAt: r.createdAt,
      threadId: r.threadId || `solo-${r.id}`,
    }));
  return { events, hidden, visibility };
}

/** Conversations for the Email tab, as this viewer may see them. hiddenThreads
 *  counts teammates' private conversations so the tab can say they exist. */
export async function listThreadsFor(
  orgId: string,
  key: string,
  viewer: string
): Promise<{ threads: EmailThread[]; hiddenThreads: number; visibility: "private" | "team" }> {
  const { events, hidden, visibility } = await listCandidateEmailsFor(orgId, key, viewer);
  const threads = threadsFrom(events);
  const visibleIds = new Set(threads.map((t) => t.id));
  const hiddenIds = new Set(hidden.map((h) => h.threadId).filter((id) => !visibleIds.has(id)));
  return { threads, hiddenThreads: hiddenIds.size, visibility };
}

/** Conversations for the Email tab: grouped by provider thread, messages
 *  oldest→newest inside, threads newest-activity first. */
export async function listThreads(orgId: string, key: string): Promise<EmailThread[]> {
  return threadsFrom(await listCandidateEmails(orgId, key));
}

function threadsFrom(rows: EmailEvent[]): EmailThread[] {
  const byThread = new Map<string, EmailEvent[]>();
  for (const m of rows) {
    const id = m.threadId || `solo-${m.id}`;
    const list = byThread.get(id) || [];
    list.push(m);
    byThread.set(id, list);
  }
  const threads: EmailThread[] = [];
  for (const [id, list] of byThread) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = list[list.length - 1];
    threads.push({
      id,
      subject: list[0].subject.replace(/^(re|fwd?):\s*/i, "") || "(no subject)",
      messages: list,
      lastAt: last.createdAt,
      awaiting: last.direction === "in",
    });
  }
  threads.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return threads;
}

/** A logged message this org sent/received for this candidate — the
 *  only thing a reply may target. */
export async function loggedMessage(
  orgId: string,
  key: string,
  messageId: string
): Promise<{ threadId: string; subject: string; memberEmail: string } | null> {
  if (!KEY_RE.test(key) || !messageId || messageId.length > 200) return null;
  const res = await sbRest(
    `candidate_email_log?organization_id=eq.${orgId}&candidate_key=eq.${key}&message_id=eq.${encodeURIComponent(
      messageId
    )}&select=thread_id,subject,member_email&limit=1`
  );
  if (!res.ok) return null;
  const [row] = (await res.json()) as { thread_id: string; subject: string; member_email: string }[];
  return row ? { threadId: row.thread_id, subject: row.subject, memberEmail: row.member_email } : null;
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
  bodyText?: string;
  quotedText?: string;
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
      body_text: (args.bodyText || "").slice(0, 20_000),
      quoted_text: (args.quotedText || "").slice(0, 20_000),
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
  // Applications match on the original email OR the drawer-edited contact
  // email — a reply from either must land in the timeline.
  const [apps, srcs] = await Promise.all([
    sbRest(
      `website_applications?organization_id=eq.${orgId}&or=(email.ilike.${pat},contact->>email.ilike.${pat})&select=id,email,contact&limit=1`
    ),
    sbRest(
      `sourced_candidates?organization_id=eq.${orgId}&contact->>email=ilike.${pat}&select=id,contact&limit=1`
    ),
  ]);
  if (apps.ok) {
    const [row] = (await apps.json()) as {
      id: string;
      email: string | null;
      contact: { email?: string | null } | null;
    }[];
    if (
      row &&
      ((row.email || "").trim().toLowerCase() === addr ||
        (row.contact?.email || "").trim().toLowerCase() === addr)
    ) {
      return `app_${row.id}`;
    }
  }
  if (srcs.ok) {
    const [row] = (await srcs.json()) as { id: string; contact: { email?: string | null } | null }[];
    if (row && (row.contact?.email || "").trim().toLowerCase() === addr) return `src_${row.id}`;
  }
  return null;
}

// Plain-text preview of a template merged for one person, for Settings →
// Email templates. The composer does the real merge (links, pills, the
// role select); this shows the words a person would read, with any field
// the composer couldn't fill shown as [field].

export type PreviewCtx = {
  candidate: { name: string };
  senderName: string;
  jobs: { id: string; title: string; company: string; url: string }[];
  trackedLink: string;
  bookingLink?: string;
  pageLink?: string;
  matchedRoles?: string[];
  referrerName?: string;
  month?: string;
  appliedRoleId?: string;
};

export function previewValues(c: PreviewCtx, subject = ""): Record<string, string> {
  const first = c.candidate.name.split(/\s+/)[0] || c.candidate.name;
  const role = c.jobs.find((j) => j.id === c.appliedRoleId) || c.jobs[0];
  return {
    first_name: first,
    full_name: c.candidate.name,
    sender_name: c.senderName,
    booking_link: c.bookingLink || "",
    page_link: c.pageLink || "",
    tracked_link: c.trackedLink || "",
    job_title: role?.title || "",
    company: role?.company || "",
    role_link: role?.url || "",
    matched_roles: (c.matchedRoles || []).join(", "),
    referrer_name: c.referrerName || "",
    month: c.month || "",
    subject,
  };
}

/** Replace {{field}} tokens; unknown or empty fields read as [field]. */
export function mergeText(tpl: string, values: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, raw: string) => values[raw.toLowerCase()] || `[${raw.replace(/_/g, " ")}]`);
}

/** The editor's HTML as the lines a person would read. */
export function htmlToLines(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

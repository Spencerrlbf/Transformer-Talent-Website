// Lead notifications: tell the job's recruiter (or the teammates the company
// chose for that job), the recruiter whose page produced the entry, or the
// company's owners when neither applies. Fail-soft like all email: a lost
// notification must never break the entry that triggered it.
import { sbRest } from "./supabase";
import { sendEmail } from "./email";
import { escapeHtml, linkedinHref, mailtoHref, plainLine } from "./html";

const CANDIDATES_URL = "https://www.transformertalent.com/dashboard/candidates";

/** Who hears about a new entry: login emails of the company's CURRENT
 *  teammates only, so someone who has left is never emailed.
 *  - Each job the person applied to: the job's own list when the company set
 *    one (notify_user_ids), else the recruiter who created the job.
 *  - The recruiter whose page they came through.
 *  - If that finds nobody (a general application, say, on a job whose
 *    creator has left): the company's owners. */
export async function leadRecipients(args: {
  recruiterProfileId: string | null;
  orgId: string | null;
  /** The company's job numbers the entry is for (none for a general
   *  application, a referral or a future-interest entry). */
  jobIds?: string[];
}): Promise<string[]> {
  if (!args.orgId) return [];
  try {
    const wanted = new Set<string>();
    if (args.recruiterProfileId && /^[0-9a-f-]{36}$/i.test(args.recruiterProfileId)) {
      const res = await sbRest(
        `recruiter_profiles?id=eq.${args.recruiterProfileId}&organization_id=eq.${args.orgId}&select=user_id`
      );
      const [row] = res.ok ? ((await res.json()) as { user_id: string }[]) : [];
      if (row?.user_id) wanted.add(row.user_id);
    }
    const jobIds = [...new Set((args.jobIds || []).filter((j) => /^[\w-]{1,40}$/.test(j)))].slice(0, 10);
    if (jobIds.length) {
      const res = await sbRest(
        `org_roles?organization_id=eq.${args.orgId}&external_id=in.(${jobIds.map((j) => `"${j}"`).join(",")})` +
          `&select=created_by,notify_user_ids`
      );
      const roles = res.ok ? ((await res.json()) as { created_by: string | null; notify_user_ids: string[] | null }[]) : [];
      for (const r of roles) for (const u of r.notify_user_ids ?? (r.created_by ? [r.created_by] : [])) wanted.add(u);
    }
    const mres = await sbRest(`org_members?organization_id=eq.${args.orgId}&select=user_id,email,member_role`);
    const members = mres.ok ? ((await mres.json()) as { user_id: string; email: string; member_role: string }[]) : [];
    let to = members.filter((m) => wanted.has(m.user_id));
    if (!to.length) to = members.filter((m) => m.member_role === "owner");
    return [...new Set(to.map((m) => (m.email || "").trim().toLowerCase()).filter(Boolean))];
  } catch (err) {
    console.error("lead recipients lookup failed", err);
    return [];
  }
}

export type LeadNotification = {
  to: string[];
  kind: "application" | "speculative" | "referral" | "future";
  /** Candidate name; falls back to their email/LinkedIn when unresolved. */
  name: string;
  email: string;
  linkedin: string;
  roleTitles: string[];
  /** Present on referrals only. */
  referrerName?: string;
  referrerEmail?: string;
  /** Present on future-interest entries: the date they asked to hear back. */
  followUpAt?: string;
  preferredRoles?: string[];
  preferredLocations?: string[];
  preferredWorkplace?: string[];
  salaryFloor?: string | null;
  visaStatus?: string | null;
  /** True when the entry came through a recruiter page. */
  viaPage: boolean;
};

/** The email itself. Everything in it that a visitor typed (name, email,
 *  LinkedIn, preferences, a referrer's details, role titles) is shown as
 *  text; the links are rebuilt from checked values. */
export function composeLeadNotification(args: LeadNotification): { subject: string; html: string } {
  const who = args.name || args.email;
  const whoHtml = escapeHtml(who);
  const surface = args.viaPage ? "your page" : "your job board";

  let subject: string;
  let lead: string;
  if (args.kind === "future") {
    const month = args.followUpAt
      ? new Date(`${args.followUpAt}T00:00:00Z`).toLocaleDateString("en-GB", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
      : "later";
    const wants = [
      (args.preferredRoles || []).join(", ") || null,
      (args.preferredWorkplace || []).join("/") || null,
      (args.preferredLocations || []).join(", ") || null,
      args.salaryFloor || null,
      args.visaStatus ? `visa: ${args.visaStatus}` : null,
    ].filter(Boolean);
    subject = `Future interest: ${who} (reach out ${month})`;
    lead =
      `<b>${whoHtml}</b> asked on ${surface} to hear from you around <b>${escapeHtml(month)}</b>.` +
      (wants.length ? `<br>They want: ${wants.map(escapeHtml).join(" · ")}.` : "");
  } else if (args.kind === "referral") {
    subject = `New referral: ${who}`;
    lead = `<b>${escapeHtml(args.referrerName || "Someone")}</b> (${escapeHtml(args.referrerEmail || "no email")})
      referred <b>${whoHtml}</b> through ${surface}.`;
  } else if (args.kind === "speculative") {
    subject = `New resume in your network: ${who}`;
    lead = `<b>${whoHtml}</b> uploaded their resume on ${surface}.`;
  } else {
    const first = args.roleTitles[0] || "a role";
    const more = args.roleTitles.length > 1 ? ` and ${args.roleTitles.length - 1} more` : "";
    subject = `New applicant: ${who} — ${first}${more}`;
    lead = `<b>${whoHtml}</b> applied on ${surface} to ${args.roleTitles
      .map((t) => `<b>${escapeHtml(t)}</b>`)
      .join(", ")}.`;
  }

  const mailto = mailtoHref(args.email);
  const linkedin = linkedinHref(args.linkedin);
  const html = `
    <p style="margin:0 0 14px;">${lead}</p>
    <p style="margin:0 0 14px;">
      Email: ${mailto ? `<a href="${escapeHtml(mailto)}" style="color:#2a5bd7;">${escapeHtml(args.email)}</a>` : escapeHtml(args.email)}<br>
      ${linkedin ? `LinkedIn: <a href="${escapeHtml(linkedin)}" style="color:#2a5bd7;">${escapeHtml(linkedin)}</a>` : ""}
    </p>
    <p style="margin:0;">
      <a href="${CANDIDATES_URL}" style="color:#2a5bd7;">Review them in your dashboard →</a>
    </p>`;
  return { subject: plainLine(subject), html };
}

export async function sendLeadNotification(args: LeadNotification): Promise<void> {
  if (args.to.length === 0) return;
  const { subject, html } = composeLeadNotification(args);
  await Promise.all(args.to.map((to) => sendEmail({ to, subject, html })));
}

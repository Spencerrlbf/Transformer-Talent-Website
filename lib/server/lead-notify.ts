// Lead notifications: tell the recruiter whose page produced an applicant,
// resume drop, or referral — or the org's owners when nothing is attributed
// (board and site applications). Fail-soft like all email: a lost
// notification must never break the entry that triggered it.
import { sbRest } from "./supabase";
import { sendEmail } from "./email";

const CANDIDATES_URL = "https://www.transformertalent.com/dashboard/candidates";

async function userEmail(userId: string): Promise<string | null> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  try {
    const res = await fetch(`${base}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const u = (await res.json()) as { email?: string };
    return u.email || null;
  } catch {
    return null;
  }
}

/** The attributed recruiter's login email, else the org owners' emails. */
export async function leadRecipients(args: {
  recruiterProfileId: string | null;
  orgId: string | null;
}): Promise<string[]> {
  try {
    if (args.recruiterProfileId) {
      const res = await sbRest(
        `recruiter_profiles?id=eq.${args.recruiterProfileId}&select=user_id`
      );
      if (res.ok) {
        const [row] = (await res.json()) as { user_id: string }[];
        const email = row ? await userEmail(row.user_id) : null;
        if (email) return [email];
      }
    }
    if (!args.orgId) return [];
    const res = await sbRest(
      `org_members?organization_id=eq.${args.orgId}&role=eq.owner&select=user_id`
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as { user_id: string }[];
    const emails = await Promise.all(rows.map((r) => userEmail(r.user_id)));
    return [...new Set(emails.filter((e): e is string => Boolean(e)))];
  } catch (err) {
    console.error("lead recipients lookup failed", err);
    return [];
  }
}

export async function sendLeadNotification(args: {
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
}): Promise<void> {
  if (args.to.length === 0) return;
  const who = args.name || args.email;
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
      `<b>${who}</b> asked on ${surface} to hear from you around <b>${month}</b>.` +
      (wants.length ? `<br>They want: ${wants.join(" · ")}.` : "");
  } else if (args.kind === "referral") {
    subject = `New referral: ${who}`;
    lead = `<b>${args.referrerName || "Someone"}</b> (${args.referrerEmail || "no email"})
      referred <b>${who}</b> through ${surface}.`;
  } else if (args.kind === "speculative") {
    subject = `New resume in your network: ${who}`;
    lead = `<b>${who}</b> uploaded their resume on ${surface}.`;
  } else {
    const first = args.roleTitles[0] || "a role";
    const more = args.roleTitles.length > 1 ? ` and ${args.roleTitles.length - 1} more` : "";
    subject = `New applicant: ${who} — ${first}${more}`;
    lead = `<b>${who}</b> applied on ${surface} to ${args.roleTitles
      .map((t) => `<b>${t}</b>`)
      .join(", ")}.`;
  }

  const html = `
    <p style="margin:0 0 14px;">${lead}</p>
    <p style="margin:0 0 14px;">
      Email: <a href="mailto:${args.email}" style="color:#2a5bd7;">${args.email}</a><br>
      ${args.linkedin ? `LinkedIn: <a href="${args.linkedin}" style="color:#2a5bd7;">${args.linkedin}</a>` : ""}
    </p>
    <p style="margin:0;">
      <a href="${CANDIDATES_URL}" style="color:#2a5bd7;">Review them in your dashboard →</a>
    </p>`;

  await Promise.all(args.to.map((to) => sendEmail({ to, subject, html })));
}
